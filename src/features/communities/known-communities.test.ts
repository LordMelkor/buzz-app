import { expect, it } from "vitest";
import {
  acknowledge,
  emptySync,
  enqueue,
  mergeList,
  parseSync,
  type SyncState,
} from "./known-communities";

const a = "wss://a.example";
const b = "wss://b.example:8443";
const withKnown = (...known: string[]): SyncState => ({
  known,
  outbox: [],
  account: "alice",
});

it("keeps one latest intent per destination: a newer intent replaces the older one", () => {
  const added = enqueue(emptySync(), a, false);
  expect(added.outbox).toEqual([{ url: a, removed: false }]);
  // Leaving while the add may be in flight replaces it: whichever of the two
  // idempotent edits lands last is the state, and the removal is the intent.
  const removed = enqueue(added, a, true);
  expect(removed.outbox).toEqual([{ url: a, removed: true }]);
  // Another destination keeps its own place; a replaced intent moves to the end.
  const both = enqueue(removed, b, false);
  expect(enqueue(both, a, false).outbox).toEqual([
    { url: b, removed: false },
    { url: a, removed: false },
  ]);
});

it("queues nothing when the latest word on the destination already says so", () => {
  // A saved community the service already holds: re-running its join.
  const present = withKnown(a);
  expect(enqueue(present, a, false)).toBe(present);
  // The same intent as the one pending.
  const adding = enqueue(emptySync(), a, false);
  expect(enqueue(adding, a, false)).toBe(adding);
  const leaving = enqueue(adding, a, true);
  expect(enqueue(leaving, a, true)).toBe(leaving);
  // Removing a destination the service is not known to hold still queues:
  // another device may have saved it, and the removal is idempotent.
  expect(enqueue(emptySync(), a, true).outbox).toEqual([
    { url: a, removed: true },
  ]);
});

it("acknowledges by moving the destination in or out of the known set and dropping the settled intent", () => {
  const queued = enqueue(enqueue(emptySync(), a, false), b, true);
  const added = acknowledge(queued, { url: a, removed: false });
  expect(added).toEqual({ known: [a], outbox: [{ url: b, removed: true }] });
  const removed = acknowledge(added, { url: b, removed: true });
  expect(removed).toEqual({ known: [a], outbox: [] });
  // Acknowledging again changes nothing: the set already agrees.
  expect(acknowledge(removed, { url: a, removed: false })).toEqual(removed);
  expect(acknowledge(removed, { url: b, removed: true })).toEqual(removed);
  expect(acknowledge(withKnown(a, b), { url: a, removed: true }).known).toEqual(
    [b],
  );
  // Both carry the account whose list the known set describes.
  expect(enqueue(withKnown(a), b, false).account).toBe("alice");
  expect(acknowledge(withKnown(a), { url: b, removed: false }).account).toBe(
    "alice",
  );
});

it("keeps an intent that replaced the acknowledged one while it was in flight", () => {
  const sent = { url: a, removed: false };
  // The user left while the add was in flight; the add landed.
  const leaving = enqueue(enqueue(emptySync(), a, false), a, true);
  const landed = acknowledge(leaving, sent);
  expect(landed).toEqual({ known: [a], outbox: [{ url: a, removed: true }] });
  // The removal then lands too, and the set follows.
  expect(acknowledge(landed, { url: a, removed: true })).toEqual(emptySync());
  // Changed their mind twice: the intent is the add that landed.
  const rejoined = enqueue(leaving, a, false);
  expect(acknowledge(rejoined, sent)).toEqual({ known: [a], outbox: [] });
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the retry simply sends the newer intent",
  ({ first }) => {
    const start = first ? withKnown(a) : emptySync();
    const intended = enqueue(start, a, first);
    expect(intended.outbox).toEqual([{ url: a, removed: first }]);
    // The service applied it but its answer never arrived; the user then
    // changed their mind. Only the newer intent remains to send, and it is
    // idempotent against whatever the service holds.
    const changed = enqueue(intended, a, !first);
    expect(changed.outbox).toEqual([{ url: a, removed: !first }]);
    const done = acknowledge(changed, { url: a, removed: !first });
    expect(done).toEqual({ ...start, known: first ? [a] : [], outbox: [] });
  },
);

it("merges a server list: adds what is listed, uploads unsynced memberships, keeps what the list omits", () => {
  const state = withKnown(b, "wss://gone.example", "wss://stale.example");
  const memberships = [
    { id: "primary" }, // alias of https://primary.example, unknown to the server
    { id: "https://b.example:8443" },
    { id: "https://gone.example" },
  ];
  const merged = mergeList(
    state,
    memberships,
    ["wss://new.example", b, b],
    "alice",
  );
  expect(merged.add).toEqual(["wss://new.example"]);
  // Known before and no longer listed (removed elsewhere, or never saved
  // here): nothing is forgotten, and the list joins the known set, so the
  // membership the service once held is not uploaded as if it had never
  // seen it. Only the alias the service has never seen is queued.
  expect(merged.state).toEqual({
    known: [
      b,
      "wss://gone.example",
      "wss://stale.example",
      "wss://new.example",
    ],
    outbox: [{ url: "wss://primary.example", removed: false }],
    account: "alice",
  });
  // The next list without it changes nothing: still saved, still not sent.
  const again = mergeList(merged.state, memberships, [b], "alice");
  expect(again.add).toEqual([]);
  expect(again.state).toEqual(merged.state);
});

it("knows nothing on behalf of another account, or of none: its list uploads what it lacks", () => {
  const memberships = [
    { id: "https://a.example" },
    { id: "https://b.example:8443" },
  ];
  // The same account no longer lists b: removed elsewhere, which is ignored
  // for now. b stays saved, known, and off the queue.
  expect(mergeList(withKnown(a, b), memberships, [a], "alice")).toEqual({
    state: { known: [a, b], outbox: [], account: "alice" },
    add: [],
  });
  // Another account signed in on this device: what alice's list held says
  // nothing about bob's, so b is a membership bob has never seen, and the
  // record now describes bob's list.
  const bob = mergeList(withKnown(a, b), memberships, [a], "bob");
  expect(bob).toEqual({
    state: { known: [a], outbox: [{ url: b, removed: false }], account: "bob" },
    add: [],
  });
  // A record that names no account reads the same way.
  expect(
    mergeList({ known: [a, b], outbox: [] }, memberships, [a], "alice").state,
  ).toEqual({ ...bob.state, account: "alice" });
});

it("defers to the pending intent when merging: no add over a queued removal, no duplicate upload", () => {
  const state: SyncState = {
    known: [b],
    outbox: [
      { url: a, removed: true },
      { url: b, removed: false },
      { url: "wss://primary.example", removed: false },
    ],
    account: "alice",
  };
  const merged = mergeList(
    state,
    [{ id: "https://b.example:8443" }, { id: "primary" }],
    [a],
    "alice",
  );
  expect(merged.add).toEqual([]);
  expect(merged.state).toEqual({
    known: [b, a],
    outbox: state.outbox,
    account: "alice",
  });
});

it("reads old or malformed saved sync fields as empty and drops malformed entries one by one", () => {
  expect(parseSync(undefined)).toEqual(emptySync());
  expect(parseSync("sync")).toEqual(emptySync());
  expect(parseSync({ known: "a", outbox: {}, account: "" })).toEqual(
    emptySync(),
  );
  expect(parseSync({ known: [], outbox: [], account: 7 })).toEqual(emptySync());
  expect(
    parseSync({
      account: "alice",
      known: [a, "https://b.example", a, 7, null],
      outbox: [
        { url: a, removed: false },
        { url: "https://a.example", removed: true },
        { url: b, removed: "yes" },
        { removed: true },
        null,
      ],
    }),
  ).toEqual({
    account: "alice",
    known: [a],
    outbox: [{ url: a, removed: false }],
  });
});
