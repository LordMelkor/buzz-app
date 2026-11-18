import { afterEach, expect, it, vi } from "vitest";
import type { PresentationLimits } from "../conversation/contracts";
import { eventDto, type EventData, type RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { createRelaySession } from "../relay/session";
import { THREAD_LIMITS } from "../relay/threads";
import type { LiveCallbacks } from "../relay/live";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "../relay/testing";
import {
  createArrangement,
  createPlace,
  nearestShown,
  placeIntent,
  type ArrangementLane,
} from "./arrangement";
import { replyTree } from "./reply-tree";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
/** An event as a verified read returns it: the only kind with proof. */
const proven = (event: RelayEvent) => eventDto(event);
const live = { phase: "live" as const, channelId: "c" };
const wide: PresentationLimits = { rows: 460, events: 2000, bytes: 4 << 20 };

function setup(publish: (event: RelayEvent) => Promise<void>) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let callbacks!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(next) {
        callbacks = next;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  callbacks.receive([roster(relay, "c", [viewer.pubkey], 1)]);
  return { session: owner.session, receive: callbacks.receive };
}
function host(
  options: {
    rootId?: string;
    limits?: PresentationLimits;
    publish?: (event: RelayEvent) => Promise<void>;
  } = {},
) {
  const world = setup(options.publish ?? (() => new Promise<void>(() => {})));
  const frames = new Map<number, () => void>();
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    frames.set(++handle, run);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const arrangement = createArrangement({
    session: world.session,
    channelId: "c",
    rootId: options.rootId,
    limits: options.limits ?? wide,
  });
  const seen: unknown[] = [];
  arrangement.subscribe(() => seen.push(arrangement.snapshot()));
  return {
    ...world,
    arrangement,
    seen,
    frames,
    /** The one animation frame that follows. */
    frame() {
      for (const [id, run] of [...frames]) {
        frames.delete(id);
        run();
      }
    },
  };
}
const lane = (key: string, order?: number): ArrangementLane => ({
  key,
  order,
});
const reaction = (author: Key, target: EventData, time: number) =>
  proven(
    signed(author, {
      kind: 7,
      content: "👍",
      created_at: time,
      tags: [
        ["h", "c"],
        ["e", target.id],
      ],
    }),
  );
const deletion = (author: Key, targets: readonly string[], time: number) =>
  proven(
    signed(author, {
      kind: 5,
      content: "",
      created_at: time,
      tags: [["h", "c"], ...targets.map((id) => ["e", id])],
    }),
  );
const reply = (author: Key, root: EventData, time: number, text = "r") =>
  proven(message(author, "c", text, time, [["e", root.id, "", "reply"]]));
function thread(count = 3) {
  const root = proven(message(other, "c", "root", 10));
  const replies = Array.from({ length: count }, (_, index) =>
    reply(other, root, 11 + index, `reply ${index}`),
  );
  // Typed as the most the tests destructure.
  return {
    root,
    replies: replies as unknown as [
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
    ],
    events: [root, ...replies],
  };
}
const ids = (rows: readonly { id: string }[] | undefined) =>
  rows?.map((row) => row.id);

it("shows the named rows in ids order, skipping ids that do not fold and the root", () => {
  const { root, replies, events } = thread();
  const { arrangement } = host({ rootId: root.id });
  const [a, b, c] = replies;
  expect(
    arrangement.present(lane("one"), {
      ids: [c?.id, root.id, "unknown", a?.id, b?.id] as string[],
      events,
    }),
  ).toBe("shown");
  expect(ids(arrangement.snapshot()?.rows)).toEqual([c?.id, a?.id, b?.id]);
});

it("shows top-level rows of a channel and drops replies", () => {
  const { root, replies, events } = thread(1);
  const second = proven(message(other, "c", "second", 30));
  const { arrangement } = host();
  arrangement.present(lane("one"), {
    ids: [second.id, replies[0]?.id ?? "", root.id],
    events: [...events, second],
  });
  expect(ids(arrangement.snapshot()?.rows)).toEqual([second.id, root.id]);
});

it("passes parents, open, complete and place through, nested to depth 4", () => {
  const { root, replies, events } = thread(5);
  const [a, b, c, d, e] = replies.map((row) => row.id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const { arrangement } = host({ rootId: root.id });
  arrangement.present(lane("one"), {
    ids: [a, b, c, d, e],
    events,
    parents: { [b]: a, [c]: b, [d]: c, [e]: d },
    open: [b],
    complete: true,
    place: { id: c },
  });
  const display = arrangement.snapshot();
  expect(display).toMatchObject({
    open: [b],
    complete: true,
    place: { id: c },
  });
  const tree = replyTree(display?.rows ?? [], root.id, (id) =>
    display?.parents?.get(id),
  );
  expect(tree.ancestors(e)).toEqual([d, c, b, a]);
  arrangement.present(lane("one"), { ids: [a, b], events });
  expect(arrangement.snapshot()).toMatchObject({
    open: [],
    complete: false,
    place: "keep",
  });
  expect(arrangement.snapshot()?.parents).toBeUndefined();
  // An empty record is a request for a flat list, not for the reader's branches.
  arrangement.present(lane("one"), { ids: [a, b], events, parents: {} });
  expect(arrangement.snapshot()?.parents?.size).toBe(0);
});

it("refuses duplicate ids and too many rows, events or bytes, and keeps what it shows", () => {
  const { root, replies, events } = thread();
  const [a, b] = replies;
  const { arrangement } = host({
    rootId: root.id,
    limits: { rows: 460, events: 4, bytes: 4 << 20 },
  });
  const first = lane("one");
  expect(arrangement.present(first, { ids: [a.id], events })).toBe("shown");
  const shown = arrangement.snapshot();
  expect(arrangement.present(first, { ids: [b.id, b.id], events })).toBe(
    "invalid",
  );
  expect(arrangement.snapshot()).toBe(shown);
  // The root and three replies are at the limit; a fourth reply is past it.
  expect(
    arrangement.present(first, { ids: replies.map((row) => row.id), events }),
  ).toBe("shown");
  const more = reply(other, root, 40);
  expect(
    arrangement.present(first, {
      ids: [...replies, more].map((row) => row.id),
      events: [...events, more],
    }),
  ).toBe("limit");
  expect(arrangement.snapshot()?.rows).toHaveLength(3);
  const small = host({
    rootId: root.id,
    limits: { rows: 460, events: 2000, bytes: 100 },
  });
  expect(small.arrangement.present(first, { ids: [a.id], events })).toBe(
    "limit",
  );
  expect(small.arrangement.snapshot()).toBeUndefined();
  // Any malformed field is refused before anything changes.
  const before = arrangement.snapshot();
  for (const bad of [
    { ids: "x" },
    { open: 1 },
    { parents: [] },
    { complete: "yes" },
    { place: null },
    { place: "end" },
    { place: { id: 1 } },
  ])
    expect(
      arrangement.present(first, { ids: [a.id], events, ...bad } as never),
    ).toBe("invalid");
  expect(arrangement.present(first, undefined as never)).toBe("invalid");
  expect(arrangement.snapshot()).toBe(before);
});

it("refuses the 461st row of a thread, the reader's bound", () => {
  const { root } = thread(0);
  const { arrangement } = host({ rootId: root.id, limits: THREAD_LIMITS });
  const names = (count: number) =>
    Array.from({ length: count }, (_, index) => `row-${index}`);
  const first = lane("one");
  expect(arrangement.present(first, { ids: names(460), events: [] })).toBe(
    "shown",
  );
  expect(arrangement.present(first, { ids: names(461), events: [] })).toBe(
    "limit",
  );
});

it("applies a live reaction and its deletion (two hops) to a row it was given by snapshot, with no re-present", () => {
  const { root, replies, events } = thread(1);
  const [row] = replies;
  const { arrangement, receive, frame } = host({ rootId: root.id });
  arrangement.present(lane("one"), { ids: [row.id], events });
  const first = reaction(other, row, 30);
  receive([first], live);
  frame();
  expect(arrangement.snapshot()?.rows[0]?.reactions).toHaveLength(1);
  receive([deletion(other, [first.id], 31)], live);
  frame();
  expect(arrangement.snapshot()?.rows[0]?.reactions).toHaveLength(0);
  // It never adds a row: a new live reply is not shown.
  receive([reply(other, root, 32, "late")], live);
  frame();
  expect(arrangement.snapshot()?.rows).toHaveLength(1);
});

it("applies a NIP-09 deletion that has no h tag, by snapshot and live, as the readers do", () => {
  const { root, replies, events } = thread(2);
  const [first, second] = replies;
  const bare = (target: EventData, time: number) =>
    proven(
      signed(other, {
        kind: 5,
        content: "",
        created_at: time,
        tags: [["e", target.id]],
      }),
    );
  const { arrangement, receive, frame } = host({ rootId: root.id });
  arrangement.present(lane("one"), {
    ids: [first.id, second.id],
    events: [...events, bare(first, 30)],
  });
  expect(ids(arrangement.snapshot()?.rows)).toEqual([second.id]);
  receive([bare(second, 31)], live);
  frame();
  expect(arrangement.snapshot()?.rows).toEqual([]);
});

it("ends when live growth passes the limits, never trims, and shows again on a new present", () => {
  const { root, replies, events } = thread(1);
  const [row] = replies;
  const { arrangement, receive, session } = host({
    rootId: root.id,
    limits: { rows: 10, events: 4, bytes: 4 << 20 },
  });
  const first = lane("one");
  arrangement.present(first, { ids: [row.id], events });
  receive([reaction(other, row, 30), reaction(viewer, row, 31)], live);
  expect(arrangement.status(first)).toBe("shown");
  receive([reaction(other, row, 32)], live);
  expect(arrangement.status(first)).toBe("ended");
  expect(arrangement.snapshot()).toBeUndefined();
  // Its hold is gone: the row's live reactions are dropped again.
  const heard: RelayEvent[] = [];
  session.subscribeLive((batch) => heard.push(...batch.events));
  receive([reaction(other, row, 33)], live);
  expect(heard).toHaveLength(0);
  expect(arrangement.present(first, { ids: [row.id], events })).toBe("shown");
  expect(arrangement.status(first)).toBe("shown");
});

it("swaps its one hold in place: a full session still re-presents, and a withdraw frees the slot", () => {
  const { root, replies, events } = thread(2);
  const { arrangement, session } = host({ rootId: root.id });
  const first = lane("one");
  const others = Array.from({ length: 63 }, () => session.retain());
  expect(
    arrangement.present(first, { ids: [replies[0]?.id ?? ""], events }),
  ).toBe("shown");
  // No free view slot is left, and a second hold would need one.
  expect(() => session.retain()).toThrow(/capacity/);
  expect(
    arrangement.present(first, { ids: [replies[1]?.id ?? ""], events }),
  ).toBe("shown");
  expect(arrangement.present(first, null)).toBe("shown");
  expect(() => session.retain()).not.toThrow();
  for (const hold of others) hold.dispose();
});

it("answers limit when no view slot is free, and keeps what it showed", () => {
  const { root, replies, events } = thread(1);
  const { arrangement, session } = host({ rootId: root.id });
  const holds = Array.from({ length: 64 }, () => session.retain());
  expect(
    arrangement.present(lane("one"), { ids: [replies[0]?.id ?? ""], events }),
  ).toBe("limit");
  expect(arrangement.snapshot()).toBeUndefined();
  for (const hold of holds) hold.dispose();
});

it("keeps live aux for ids that stay presented, and drops it for ids that do not", () => {
  const { root, replies, events } = thread(2);
  const [a, b] = replies;
  const { arrangement, receive, frame } = host({ rootId: root.id });
  const first = lane("one");
  arrangement.present(first, { ids: [a.id, b.id], events });
  receive([reaction(other, a, 30)], live);
  frame();
  arrangement.present(first, { ids: [b.id, a.id], events });
  expect(arrangement.snapshot()?.rows[1]?.reactions).toHaveLength(1);
  arrangement.present(first, { ids: [b.id], events });
  arrangement.present(first, { ids: [a.id], events });
  expect(arrangement.snapshot()?.rows[0]?.reactions).toHaveLength(0);
});

it("keeps row identity across a refold that changed nothing for them", () => {
  const { root, replies, events } = thread(2);
  const [a, b] = replies;
  const { arrangement, receive, frame } = host({ rootId: root.id });
  arrangement.present(lane("one"), { ids: [a.id, b.id], events });
  const before = arrangement.snapshot()?.rows;
  receive([reaction(other, a, 30)], live);
  frame();
  const after = arrangement.snapshot()?.rows;
  expect(after?.[0]).not.toBe(before?.[0]);
  expect(after?.[1]).toBe(before?.[1]);
});

it("refolds at most once per frame, whatever changes", async () => {
  const { root, replies, events } = thread(1);
  const [row] = replies;
  const { arrangement, receive, frames, seen, session } = host({
    rootId: root.id,
  });
  arrangement.present(lane("one"), { ids: [row.id], events });
  await session.outbox?.ready();
  seen.length = 0;
  receive([reaction(other, row, 30)], live);
  receive([reaction(viewer, row, 31)], live);
  session.messages.react(row.id, "🎉");
  expect(frames.size).toBe(1);
  expect(seen).toHaveLength(0);
  for (const run of [...frames.values()]) run();
  expect(seen).toHaveLength(1);
  expect(arrangement.snapshot()?.rows[0]?.reactions.length).toBeGreaterThan(1);
});

it("keeps refolding live changes after a re-present that overtook a pending frame", () => {
  const { root, replies, events } = thread(1);
  const [row] = replies;
  const { arrangement, receive, frame } = host({ rootId: root.id });
  arrangement.present(lane("one"), { ids: [row.id], events });
  receive([reaction(other, row, 30)], live);
  // The re-present folds at once, so the frame the first reaction asked for is moot.
  arrangement.present(lane("one"), { ids: [row.id], events });
  receive([reaction(viewer, row, 31)], live);
  frame();
  expect(arrangement.snapshot()?.rows[0]?.reactions[0]?.events).toHaveLength(2);
});

it("shows an own pending reply only when named, and follows its delivery", async () => {
  let reject!: () => void;
  const { root, events } = thread(0);
  const { arrangement, session, receive, frame } = host({
    rootId: root.id,
    publish: () =>
      new Promise<void>((_, fail) => {
        reject = () => fail(new PublishRejected("refused"));
      }),
  });
  receive([root]);
  await session.outbox?.ready();
  session.messages.reply("c", root.id, "mine");
  const id = session.outbox?.snapshot()[0]?.event.id ?? "";
  arrangement.present(lane("one"), { ids: [], events });
  expect(arrangement.snapshot()?.rows).toEqual([]);
  // Named with no events at all.
  arrangement.present(lane("one"), { ids: [id], events: [] });
  expect(arrangement.snapshot()?.rows[0]).toMatchObject({
    content: "mine",
    delivery: "sending",
  });
  await flush();
  reject();
  await flush();
  await flush();
  frame();
  expect(arrangement.snapshot()?.rows[0]?.delivery).toBe("failed");
});

it("shows the first lane by order then key, holds the rest and promotes on withdraw", () => {
  const { root, replies, events } = thread(2);
  const [a, b] = replies;
  const { arrangement } = host({ rootId: root.id });
  const late = lane("a", 5);
  const early = lane("z", 1);
  expect(arrangement.present(late, { ids: [a.id], events })).toBe("shown");
  expect(arrangement.present(early, { ids: [b.id], events })).toBe("shown");
  expect(arrangement.status(late)).toBe("held");
  expect(arrangement.status(early)).toBe("shown");
  expect(ids(arrangement.snapshot()?.rows)).toEqual([b.id]);
  const tied = lane("b", 5);
  expect(arrangement.present(tied, { ids: [a.id], events })).toBe("held");
  expect(arrangement.present(early, null)).toBe("shown");
  expect(arrangement.status(early)).toBe("none");
  // `a` before `b` among equal orders.
  expect(arrangement.status(late)).toBe("shown");
  expect(arrangement.status(tied)).toBe("held");
  arrangement.present(late, null);
  arrangement.present(tied, null);
  expect(arrangement.snapshot()).toBeUndefined();
});

it("promotes a held lane when the shown one ends", () => {
  const { root, replies, events } = thread(2);
  const [a, b] = replies;
  const { arrangement, receive } = host({
    rootId: root.id,
    limits: { rows: 10, events: 4, bytes: 4 << 20 },
  });
  const first = lane("a");
  const second = lane("b");
  arrangement.present(first, { ids: [a.id], events });
  arrangement.present(second, { ids: [b.id], events });
  receive([reaction(other, a, 30), reaction(other, a, 31)], live);
  receive([reaction(other, a, 32)], live);
  expect(arrangement.status(first)).toBe("ended");
  expect(arrangement.status(second)).toBe("shown");
  expect(ids(arrangement.snapshot()?.rows)).toEqual([b.id]);
});

it("keeps its own copy of what a held lane selected, not the plugin's whole read", () => {
  const { root, replies, events } = thread(3);
  const [a, b] = replies;
  const { arrangement } = host({ rootId: root.id });
  const first = lane("a");
  const second = lane("b");
  arrangement.present(first, { ids: [a.id], events });
  // The plugin's read, which it reuses as its buffer once it has presented.
  const scan = [...events, reaction(other, b, 30)];
  expect(arrangement.present(second, { ids: [b.id], events: scan })).toBe(
    "held",
  );
  scan.length = 0;
  arrangement.present(first, null);
  expect(arrangement.status(second)).toBe("shown");
  const [row] = arrangement.snapshot()?.rows ?? [];
  expect(row?.id).toBe(b.id);
  expect(row?.reactions).toHaveLength(1);
});

it("ends a promoted lane that no longer fits, and falls back to the host's rows", () => {
  const { root, replies, events } = thread(1);
  const [a] = replies;
  const { arrangement, receive } = host({
    rootId: root.id,
    limits: { rows: 10, events: 4, bytes: 4 << 20 },
  });
  const first = lane("a");
  const second = lane("b");
  // Both name the row, so the live reactions that ended `first` count for `second`.
  arrangement.present(first, { ids: [a.id], events });
  arrangement.present(second, { ids: [a.id], events });
  receive([reaction(other, a, 30), reaction(other, a, 31)], live);
  receive([reaction(other, a, 32)], live);
  expect(arrangement.status(first)).toBe("ended");
  expect(arrangement.status(second)).toBe("ended");
  expect(arrangement.snapshot()).toBeUndefined();
});

it("keeps a presentation through a StrictMode replay and retires after a real unmount", async () => {
  const { root, replies, events } = thread(1);
  const [a] = replies;
  const { arrangement, receive, session } = host({ rootId: root.id });
  const first = lane("a");
  arrangement.present(first, { ids: [a.id], events });
  arrangement.retire();
  arrangement.attach();
  await Promise.resolve();
  expect(arrangement.status(first)).toBe("shown");
  expect(arrangement.present(first, { ids: [a.id], events })).toBe("shown");
  const heard: RelayEvent[] = [];
  session.subscribeLive((batch) => heard.push(...batch.events));
  receive([reaction(other, a, 30)], live);
  expect(heard).toHaveLength(1);
  arrangement.retire();
  // Still open to a replay until the commit ends.
  expect(arrangement.status(first)).toBe("shown");
  await Promise.resolve();
  expect(arrangement.snapshot()).toBeUndefined();
  expect(arrangement.status(first)).toBe("none");
  expect(arrangement.present(first, { ids: [a.id], events })).toBe("retired");
  arrangement.attach();
  expect(arrangement.present(first, { ids: [a.id], events })).toBe("retired");
  receive([reaction(other, a, 31)], live);
  expect(heard).toHaveLength(1);
});

it("tells a subscriber each change of display and lane status, and no more", () => {
  const { root, replies, events } = thread(1);
  const [a] = replies;
  const { arrangement, seen } = host({ rootId: root.id });
  const first = lane("a");
  arrangement.present(first, { ids: [a.id], events });
  expect(seen).toHaveLength(1);
  expect(arrangement.snapshot()?.revision).toBe(1);
  arrangement.present(first, { ids: [a.id], events });
  expect(arrangement.snapshot()?.revision).toBe(2);
  arrangement.present(first, null);
  expect(arrangement.snapshot()).toBeUndefined();
  expect(seen).toHaveLength(3);
});

const order = ["a", "b", "c", "d", "e"];
const anchor = (id: string) => ({ id, top: 12, order });

it("finds the nearest shown row to a kept anchor, preferring the row below", () => {
  expect(nearestShown(anchor("c"), () => true)).toBe("c");
  expect(nearestShown(anchor("c"), (id) => id !== "c")).toBe("d");
  expect(nearestShown(anchor("c"), (id) => ["a", "b"].includes(id))).toBe("b");
  expect(nearestShown(anchor("c"), (id) => id === "a")).toBe("a");
  expect(nearestShown(anchor("c"), () => false)).toBeUndefined();
  expect(nearestShown(anchor("zz"), () => true)).toBeUndefined();
});

it("holds one pending place until it is applied, replaced by a later one, cancelled by input", () => {
  const place = createPlace();
  const all = () => true;
  expect(place.take(all)).toBeUndefined();
  place.capture({ kind: "end" });
  place.capture({ kind: "start" });
  expect(place.take(all)).toBe("start");
  // Held until done: a row in a closed branch needs another commit to place.
  expect(place.take(() => false)).toBe("start");
  place.done();
  expect(place.take(all)).toBeUndefined();
  place.capture({ kind: "end" });
  place.cancel();
  expect(place.take(all)).toBeUndefined();
  place.capture({ kind: "end" });
  expect(place.take(all)).toBe("end");
  // A capture drops a placement not yet applied.
  place.capture({ kind: "keep", ...anchor("c") });
  expect(place.take((id) => id === "d")).toEqual({ id: "d", top: 12 });
  place.cancel();
  expect(place.take(all)).toBeUndefined();
  place.capture({ kind: "keep", ...anchor("c") });
  expect(place.take(() => false)).toBe("start");
  place.done();
  place.capture({ kind: "keep", ...anchor("c") });
  expect(place.take(() => false, "end")).toBe("end");
  place.done();
  place.capture({ kind: "reveal", id: "b" });
  expect(place.take((id) => id === "b")).toEqual({ id: "b", top: 0 });
  place.done();
  place.capture({ kind: "reveal", id: "b" });
  expect(place.take(() => false)).toBeUndefined();
});

it("maps a presentation's place to an intent, keeping the anchor by default", () => {
  expect(placeIntent("keep", anchor("c"))).toEqual({
    kind: "keep",
    ...anchor("c"),
  });
  expect(placeIntent("keep", undefined)).toEqual({ kind: "start" });
  expect(placeIntent("start", anchor("c"))).toEqual({ kind: "start" });
  expect(placeIntent({ id: "b" }, anchor("c"))).toEqual({
    kind: "reveal",
    id: "b",
  });
});
