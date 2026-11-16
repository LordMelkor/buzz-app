import { expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import { createMentionGroups } from "./mention-groups";

const author = "f".repeat(64);
const viewer = "1".repeat(64);
const admin = "2".repeat(64);
const person = "3".repeat(64);
const removed = "4".repeat(64);
const agent = "5".repeat(64);
const groupA = "0659678f-fddb-40df-a285-35f6b41db019";
const groupB = "1b0e8c2a-3f4d-4c5e-9a6b-7c8d9e0f1a2b";
let sequence = 0;
const id = () => (++sequence).toString(16).padStart(64, "0");

function head(
  d: string,
  version: number,
  name: string,
  members: string[],
  extra: string[][] = [],
  created_at = 1000 + version,
): EventData {
  return {
    id: id(),
    pubkey: author,
    kind: 39010,
    created_at,
    content: "",
    tags: [
      ["-"],
      ["d", d],
      ["name", name],
      ["version", String(version)],
      ["command", "c".repeat(64)],
      ...members.map((key) => ["p", key]),
      ...extra,
    ],
  };
}
const tombstone = (d: string, version: number): EventData => ({
  id: id(),
  pubkey: author,
  kind: 39010,
  created_at: 2000 + version,
  content: "",
  tags: [
    ["-"],
    ["d", d],
    ["version", String(version)],
    ["command", "c".repeat(64)],
    ["deleted", "true"],
  ],
});
const settings = (manage: string, version: number): EventData => ({
  id: id(),
  pubkey: author,
  kind: 39010,
  created_at: 3000 + version,
  content: "",
  tags: [
    ["-"],
    ["d", "settings"],
    ["manage", manage],
    ["version", String(version)],
    ["command", "c".repeat(64)],
  ],
});
const roster = (members: [string, string][]): EventData => ({
  id: id(),
  pubkey: author,
  kind: 13534,
  created_at: 500,
  content: "",
  tags: members.map(([key, role]) => ["member", key, role]),
});

/** A relay holding `stored` events, answering reads like the relay's cursor. */
function harness(
  stored: EventData[],
  options: {
    membership?: "open" | "roster";
    maxMembers?: number;
    send?: (body: Record<string, unknown>) => Promise<unknown>;
    profiles?: EventData[];
  } = {},
) {
  const reads: ReadFilter[][] = [];
  let fail: Error | undefined;
  let gate: Promise<void> | undefined;
  const live = new Set<(batch: { events: readonly EventData[] }) => void>();
  const reconnect = new Set<() => void>();
  const sent: Record<string, unknown>[] = [];
  let clock = 10_000;
  const owner = createMentionGroups({
    support: {
      membership: options.membership ?? "open",
      defaultManage: "everyone",
      ...(options.maxMembers ? { maxMembers: options.maxMembers } : {}),
    },
    viewer,
    relayAuthor: author,
    now: () => clock,
    async read(filters) {
      reads.push([...filters]);
      await gate;
      if (fail) throw fail;
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return (options.profiles ?? []).filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        const matches = stored
          .filter(
            (event) =>
              filter.kinds?.includes(event.kind) &&
              (!filter["#d"] ||
                filter["#d"].includes(
                  event.tags.find(([n]) => n === "d")?.[1] ?? "",
                )) &&
              (filter.until === undefined ||
                event.created_at < filter.until ||
                (event.created_at === filter.until &&
                  event.id > (filter.before_id ?? ""))),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          );
        return matches.slice(0, Math.min(filter.limit, 2));
      });
    },
    async send(body) {
      sent.push(body);
      return (options.send?.(body) ?? {
        accepted: true,
        event_id: "x",
      }) as never;
    },
    subscribeLive(listener) {
      live.add(listener);
      return () => live.delete(listener);
    },
    subscribeReconnect(listener) {
      reconnect.add(listener);
      return () => reconnect.delete(listener);
    },
  });
  return {
    owner,
    reads,
    sent,
    stored,
    snapshot: () => owner.directory.snapshot(),
    deliver: (...events: EventData[]) => {
      for (const listener of live) listener({ events });
    },
    reconnect: () => {
      for (const listener of reconnect) listener();
    },
    failReads: (error?: Error) => {
      fail = error;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
    tick: (seconds: number) => {
      clock += seconds;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("pages every head before showing groups, newest version per group, and keeps a deleted group hidden", async () => {
  // Pages of two: the relay's cursor walks five heads, ties included.
  const h = harness([
    head(groupA, 1, "Old name", [person]),
    head(groupA, 3, "On call", [person, admin]),
    head(groupB, 1, "Design", [person], [], 1003),
    tombstone("2e9b7c3d-1a2b-4c3d-8e4f-5a6b7c8d9e0f", 2),
    // Malformed: one bad head is dropped and the rest stay.
    { ...head(groupB, 9, "", [person]), tags: [["d", groupB]] },
    roster([[admin, "admin"]]),
  ]);
  expect(h.snapshot()).toMatchObject({ status: "loading", groups: [] });
  await settle();
  expect(h.reads.length).toBeGreaterThan(3);
  expect(h.snapshot()).toMatchObject({
    status: "ready",
    groups: [
      { id: groupB, name: "Design", members: [person] },
      { id: groupA, name: "On call", version: "3", members: [person, admin] },
    ],
  });
  expect(h.owner.recovery.status()).toBe("settled");
});

it("folds live heads by version, ignores older ones, and repairs an equal-version conflict once", async () => {
  const h = harness([head(groupA, 2, "On call", [person])]);
  await settle();
  const reads = h.reads.length;
  h.deliver(head(groupA, 1, "Older", [person]));
  expect(h.snapshot().groups[0]).toMatchObject({ name: "On call" });
  h.deliver(head(groupA, 3, "Renamed", [person, admin]));
  expect(h.snapshot().groups[0]).toMatchObject({
    name: "Renamed",
    version: "3",
  });
  // The same version under another id is a protocol error: keep the current
  // head and read the authoritative one, once per version.
  h.deliver(head(groupA, 3, "Fork", [person]));
  h.deliver(head(groupA, 3, "Fork again", [person]));
  await settle();
  expect(h.snapshot().groups[0]).toMatchObject({ name: "Renamed" });
  expect(h.reads.length).toBeGreaterThan(reads);
  const repaired = h.reads.length;
  h.deliver(head(groupA, 3, "Third fork", [person]));
  await settle();
  expect(h.reads.length).toBe(repaired);
  // A tombstone removes the row; a missing head never does.
  h.deliver(tombstone(groupA, 4));
  expect(h.snapshot().groups).toEqual([]);
});

it("never empties on a failed reconcile, retries through recovery, and runs one trailing read for overlapping reconnects", async () => {
  const h = harness([head(groupA, 1, "On call", [person])]);
  await settle();
  h.failReads(new Error("offline"));
  h.reconnect();
  await settle();
  expect(h.snapshot()).toMatchObject({
    status: "ready",
    error: "offline",
    groups: [{ name: "On call" }],
  });
  expect(h.owner.recovery.status()).toBe("failed");
  h.failReads();
  h.stored.push(head(groupB, 1, "Design", [person]));
  h.owner.recovery.retry();
  await settle();
  expect(h.snapshot().groups.map((g) => g.name)).toEqual(["Design", "On call"]);
  expect(h.owner.recovery.status()).toBe("settled");
  // Many reconnect signals during one read: that read, then one more.
  const release = h.hold();
  const before = h.reads.length;
  h.reconnect();
  h.reconnect();
  h.reconnect();
  expect(h.owner.recovery.status()).toBe("busy");
  release();
  await settle();
  await settle();
  const firstPages = h.reads
    .slice(before)
    .filter((filters) => filters.length === 2).length;
  expect(firstPages).toBe(2);
});

it("shows nothing and reports unavailable when the first read fails", async () => {
  const h = harness([head(groupA, 1, "On call", [person])]);
  h.failReads(new Error("offline"));
  await settle();
  // Live heads alone are not a complete directory.
  h.deliver(head(groupA, 2, "On call", [person]));
  expect(h.snapshot()).toMatchObject({
    status: "unavailable",
    groups: [],
    error: "offline",
  });
});

it("on a roster relay offers only current members and owner-admitted agents", async () => {
  // NIP-OA test vector (owner secret 1, agent secret 2), as in
  // owner-attestation.test.ts: the owner is a roster member.
  const owner =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const admittedAgent =
    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
  const proof = [
    "auth",
    owner,
    "kind=1&created_at<1713957000",
    "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
  ];
  const profile = (pubkey: string, auth: string[]): EventData => ({
    id: id(),
    pubkey,
    kind: 0,
    created_at: 1,
    content: "{}",
    tags: [auth],
  });
  const h = harness(
    [
      head(groupA, 1, "On call", [person, removed, admittedAgent, agent]),
      roster([
        [person, "member"],
        [owner, "member"],
        [viewer, "member"],
      ]),
    ],
    {
      membership: "roster",
      maxMembers: 20,
      profiles: [
        profile(admittedAgent, proof),
        // A forged proof names a member but is not signed by them.
        profile(agent, ["auth", owner, "", "a".repeat(128)]),
      ],
    },
  );
  await settle();
  // While the profile lookup runs, the group waits rather than sending to a
  // partial set.
  expect(h.snapshot().groups[0]?.members).toBeNull();
  await vi.waitFor(() =>
    expect(h.snapshot().groups[0]?.members).toEqual([person, admittedAgent]),
  );
  expect(h.snapshot().groups[0]?.stored).toEqual([
    person,
    removed,
    admittedAgent,
    agent,
  ]);
  // An open relay never filters.
  const open = harness([head(groupA, 1, "On call", [person, removed])]);
  await settle();
  // The relay's advertised group size limit reaches the editor; none here.
  expect(h.snapshot().maxMembers).toBe(20);
  expect(open.snapshot().maxMembers).toBeUndefined();
  expect(open.snapshot().groups[0]?.members).toEqual([person, removed]);
});

it("lets any member edit under Everyone, only stewards under admins, and only stewards change the setting", async () => {
  const stewards = roster([
    [admin, "admin"],
    [person, "member"],
  ]);
  const h = harness([stewards]);
  await settle();
  // No setting head yet: the default is Everyone at version 0.
  expect(h.snapshot()).toMatchObject({
    manage: "everyone",
    settingVersion: "0",
    canEdit: true,
    canManage: false,
  });
  h.deliver(settings("admins", 1));
  expect(h.snapshot()).toMatchObject({
    manage: "admins",
    settingVersion: "1",
    canEdit: false,
    canManage: false,
  });
  h.deliver({
    ...stewards,
    id: id(),
    created_at: 600,
    tags: [["member", viewer, "admin"]],
  });
  expect(h.snapshot()).toMatchObject({
    role: "admin",
    canEdit: true,
    canManage: true,
  });
  // A community with no steward lets any member change it.
  const rosterless = harness([settings("admins", 2)]);
  await settle();
  expect(rosterless.snapshot()).toMatchObject({
    canEdit: true,
    canManage: true,
  });
});

it("resends the same event after an unknown outcome and types each relay answer", async () => {
  let answer: () => Promise<unknown> = () =>
    Promise.reject(new Error("Failed to fetch"));
  const h = harness([], { send: () => answer() });
  await settle();
  const input = {
    id: groupA,
    prev: "0",
    name: "On call",
    members: [person],
    channels: [],
  };
  const lost = await h.owner.put(input);
  expect(lost).toMatchObject({ outcome: "unknown" });
  answer = () => Promise.resolve({ accepted: true, event_id: lost.eventId });
  h.tick(30);
  const retried = await lost.retry?.();
  expect(retried).toMatchObject({ outcome: "accepted", eventId: lost.eventId });
  expect(h.sent[1]).toEqual(h.sent[0]);
  // After acceptance, the changed head is read in case live delivery lags.
  expect(h.reads.at(-1)?.[0]).toMatchObject({ "#d": [groupA], limit: 1 });
  for (const [text, outcome] of [
    ["conflict: mention group version changed", "conflict"],
    ["duplicate: mention group name already exists", "name-taken"],
    [
      "restricted: community policy does not permit this mention group command",
      "forbidden",
    ],
    ["invalid: name too long", "invalid"],
    ["Community request failed (500)", "unknown"],
  ] as const) {
    answer = () => Promise.reject(new Error(text));
    const result = await h.owner.put(input);
    expect(result.outcome).toBe(outcome);
    expect(!!result.retry).toBe(outcome === "unknown");
  }
  // Long after the relay's freshness window, a retry is still the same
  // event: the relay answers an accepted one from its receipt.
  answer = () => Promise.reject(new Error("Failed to fetch"));
  const stale = await h.owner.setManage({ manage: "admins", prev: "0" });
  h.tick(60 * 60);
  answer = () =>
    Promise.resolve({
      accepted: true,
      message: 'duplicate: joins: {"joined":2,"skipped":{"channel_closed":1}}',
    });
  const resent = await stale.retry?.();
  expect(resent).toMatchObject({
    outcome: "accepted",
    eventId: stale.eventId,
    joins: { joined: 2, skipped: { channel_closed: 1 } },
  });
  expect(h.sent.at(-1)).toEqual(h.sent.at(-2));
});

it("reads and sends nothing when the relay has no mention groups", async () => {
  const read = vi.fn();
  const owner = createMentionGroups({
    support: undefined,
    viewer,
    relayAuthor: author,
    read,
    send: vi.fn(),
    subscribeLive: () => () => {},
    subscribeReconnect: () => () => {},
  });
  await settle();
  expect(read).not.toHaveBeenCalled();
  expect(owner.supported).toBe(false);
  expect(owner.directory.snapshot()).toMatchObject({
    status: "unsupported",
    groups: [],
  });
  await expect(owner.remove({ id: groupA, prev: "1" })).rejects.toThrow();
});
