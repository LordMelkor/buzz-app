import { assert, afterEach, expect, it, vi } from "vitest";
import type { OutgoingEvent, OutboxStorage } from "./outbox";
import type { ChannelStoreOptions } from "./store";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import {
  type Key,
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  signed,
  profile,
  scriptedTransport,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair(),
  bob = keypair(),
  carol = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  options: ChannelStoreOptions & { outboxStorage?: OutboxStorage } = {},
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(options.outboxStorage
        ? {
            writer: {
              sign: vi.fn(async () => {
                throw new Error("no automatic signing");
              }),
              publish: vi.fn(async () => {}),
            },
          }
        : {}),
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    options,
  );
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    emit: (events: readonly RelayEvent[]) => incoming(events),
  };
}
const filters = [{ kinds: [9], limit: 20 }];

it("purges existing and newly opened broad/ID views through store denial, not just pending #h reads", async () => {
  const h = setup();
  const secret = message(alice, "a", "private", 10),
    other = message(alice, "b", "unrelated", 20);
  h.emit([secret, other]);
  const view = h.session.observe(filters);
  const ids = h.session.observe([{ ids: [secret.id], limit: 1 }]);
  expect(view.snapshot().events).toHaveLength(2);
  h.session.channels.ensure("a");
  h.next().fail(new Error("Relay read failed (403)"));
  await flush();
  expect(view.snapshot().events.map((e) => e.id)).toEqual([other.id]);
  expect(ids.snapshot().events).toEqual([]);
  expect(
    h.session
      .observe(filters)
      .snapshot()
      .events.map((e) => e.id),
  ).toEqual([other.id]);
  h.emit([secret]);
  expect(view.snapshot().events.map((e) => e.id)).toEqual([other.id]);
  const read = h.session.read([{ ids: [secret.id], limit: 1 }]);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([secret]);
  expect(await read).toEqual([]);
});

it("fences broad and ID reads across revoke/regrant, and accepts fresh work only", async () => {
  const h = setup();
  h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
  const broad = h.session.read(filters),
    idRead = h.session.read([{ ids: ["a".repeat(64)], limit: 1 }]);
  const stale = h.next(),
    staleId = h.next();
  const rejected = Promise.all([
    expect(broad).rejects.toMatchObject({ name: "AbortError" }),
    expect(idRead).rejects.toMatchObject({ name: "AbortError" }),
  ]);
  h.emit([roster(relay, "a", [], 11)]);
  expect(stale.signal?.aborted).toBe(true);
  expect(staleId.signal?.aborted).toBe(true);
  h.emit([roster(relay, "a", [viewer.pubkey], 12)]);
  await rejected;
  const secret = message(alice, "a", "old response", 9);
  stale.respond([secret]);
  staleId.respond([secret]);
  await flush();
  const view = h.session.observe(filters);
  expect(view.snapshot().events).toEqual([]);
  h.emit([message(alice, "a", "fresh", 13)]);
  expect(view.snapshot().events.map((e) => e.content)).toEqual(["fresh"]);
});

it.each([
  [{ authors: [viewer.pubkey], kinds: [30177, 9] }],
  [{ authors: [viewer.pubkey], kinds: [30177] }, { kinds: [9] }],
  [{ authors: [alice.pubkey], kinds: [30177] }],
  [{ authors: [viewer.pubkey], kinds: [30177], "#h": ["a"] }],
  [{ authors: [viewer.pubkey], kinds: [30177], ids: ["a".repeat(64)] }],
])(
  "does not exempt mixed or non-owner inventory-shaped reads from revocation: %j",
  async (...filters) => {
    const h = setup();
    h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
    const read = h.session.read(
      filters.map((filter) => ({ ...filter, limit: 20 })),
    );
    const request = h.next();
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    h.emit([roster(relay, "a", [], 11)]);
    expect(request.signal?.aborted).toBe(true);
    await rejected;
  },
);

it("denying one channel retires another's permission read, which rereads until answered", async () => {
  const h = setup();
  const [a, b, c] = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  h.emit(
    [a, b, c].map((id, index) =>
      roster(relay, id, [viewer.pubkey], 10 + index),
    ),
  );
  const load = h.session.channelLifecycle.load(c);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  let request = h.next();
  for (const denied of [a, b]) {
    h.session.channels.ensure(denied);
    h.next().fail(new Error("Relay read failed (403)"));
    await vi.waitFor(() => expect(request.signal?.aborted).toBe(true));
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    request = h.next();
    for (const filter of request.filters) expect(filter["#d"]).toEqual([c]);
  }
  request.respond([
    metadata(relay, c, "c", 20, [["t", "stream"]]),
    signed(relay, {
      kind: 39001,
      content: "",
      tags: [
        ["d", c],
        ["p", viewer.pubkey, "owner"],
      ],
    }),
    roster(relay, c, [viewer.pubkey], 20),
  ]);
  expect(await load).toMatchObject({ canArchive: true, canDelete: true });
  expect(h.session.channels.list().channels.map((ch) => ch.id)).toEqual([c]);
});

it("session dispose aborts an in-flight permission read without rereading", async () => {
  const h = setup();
  const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.emit([roster(relay, c, [viewer.pubkey], 10)]);
  const load = h.session.channelLifecycle.load(c);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
  // Disposal retires the shared read without the lifecycle rereading it:
  // the closed lifecycle rejects before it reaches the closed reader, which
  // would otherwise reject each reread synchronously.
  h.dispose();
  await rejected;
  expect(h.pending).toHaveLength(1);
  expect(h.pending[0]?.signal?.aborted).toBe(true);
});

it("a complete roster omitting a generic-only channel purges it; partial live discovery does not", async () => {
  const h = setup();
  h.emit([message(alice, "a", "private", 10)]);
  const view = h.session.observe(filters);
  h.emit([roster(relay, "b", [viewer.pubkey], 10)]);
  expect(view.snapshot().events).toHaveLength(1);
  h.session.channels.refreshList?.();
  h.next().respond([
    roster(relay, "b", [viewer.pubkey], 10),
    metadata(relay, "b", "B"),
  ]);
  await flush();
  expect(view.snapshot().events).toEqual([]);
});

it("processes access loss before reconciling other events in the same live batch", () => {
  const h = setup();
  h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
  const view = h.session.observe(filters);
  const exposed: string[] = [];
  view.subscribe(() =>
    exposed.push(...view.snapshot().events.map((e) => e.content)),
  );
  h.emit([
    message(alice, "a", "must not flash", 11),
    roster(relay, "a", [], 11),
  ]);
  expect(view.snapshot().events).toEqual([]);
  expect(exposed).toEqual([]);
});

it("ordinary channel history still reconciles after partial discovery", async () => {
  const h = setup();
  h.emit([roster(relay, "b", [viewer.pubkey], 10)]);
  h.session.channels.ensure("a");
  h.next().respond([
    message(alice, "a", "read", 10),
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window("a").rows.map((r) => r.content)).toEqual([
    "read",
  ]);
});

it.each([false, true])(
  "reference-only auxiliaries require all targets, independent of batch order (%s)",
  (reverse) => {
    const h = setup();
    const secret = message(alice, "a", "private", 10);
    const other = message(alice, "b", "allowed", 10);
    const entity = signed(alice, {
      kind: 30617,
      content: "public repository",
      tags: [["d", "repo"]],
    });
    const reaction = (ids: string[], tags: string[][] = []) =>
      signed(alice, {
        kind: 7,
        content: ids.join(","),
        tags: [...tags, ...ids.map((id) => ["e", id])],
      });
    const privateReaction = reaction([secret.id]);
    const publicReaction = reaction([entity.id]);
    const mixed = reaction([other.id, secret.id]);
    const unknown = reaction([other.id, "f".repeat(64)], [["h", "b"]]);
    h.emit([roster(relay, "a", [], 11)]);
    const batch = [
      secret,
      other,
      entity,
      privateReaction,
      publicReaction,
      mixed,
      unknown,
    ];
    h.emit(reverse ? batch.reverse() : batch);
    const view = h.session.observe([{ kinds: [7, 30617], limit: 20 }]);
    expect(new Set(view.snapshot().events.map((e) => e.id))).toEqual(
      new Set([entity.id, publicReaction.id]),
    );
  },
);

it("purges retained reference-only evidence and signed profiles with a denied parent", () => {
  const h = setup();
  const secret = message(alice, "a", "private", 10);
  const edit = signed(alice, {
    kind: 40003,
    content: "private edit",
    tags: [["e", secret.id]],
  });
  h.emit([secret, edit, profile(alice, { name: "Private identity" })]);
  const view = h.session.observe([{ kinds: [0, 40003], limit: 20 }]);
  expect(view.snapshot().events).toHaveLength(2);
  h.emit([roster(relay, "a", [], 11)]);
  expect(view.snapshot().events).toEqual([]);
  expect(h.session.profiles.snapshot().size).toBe(0);
  h.emit([edit]);
  expect(view.snapshot().events).toEqual([]);
});

it("regrants from a fresh discovery read, never from replayed membership after complete omission", async () => {
  const h = setup();
  const grant = roster(relay, "a", [viewer.pubkey], 10);
  h.emit([grant]);
  h.session.channels.refreshList?.();
  h.next().respond([]);
  await flush();
  h.emit([grant, message(alice, "a", "old", 10)]);
  expect(h.session.observe(filters).snapshot().events).toEqual([]);
  h.session.channels.refreshList?.();
  h.next().respond([
    roster(relay, "a", [viewer.pubkey], 12),
    metadata(relay, "a", "A"),
  ]);
  await flush();
  expect(h.session.channels.list().channels.map((c) => c.id)).toEqual(["a"]);
  h.emit([message(alice, "a", "fresh", 13)]);
  expect(
    h.session
      .observe(filters)
      .snapshot()
      .events.map((e) => e.content),
  ).toEqual(["fresh"]);
});

it("fences a finite read already resolved by the scheduler when its view callback revokes access", async () => {
  const h = setup();
  const view = h.session.observe(filters);
  view.subscribe(() => {
    if (view.snapshot().events.length) h.emit([roster(relay, "a", [], 11)]);
  });
  const read = h.session.read(filters);
  h.next().respond([message(alice, "a", "private", 10)]);
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  expect(view.snapshot().events).toEqual([]);
});

it.each([false, true])(
  "revocation preserves signed pending intent but purges confirmed retention across regrant (async load %s)",
  async (asyncLoad) => {
    const pending = message(viewer, "a", "unknown write", 10);
    const confirmed = message(viewer, "a", "confirmed write", 9);
    let records: readonly OutgoingEvent[] = [
      { event: pending, signed: pending, delivery: "unknown" },
      { event: confirmed, signed: confirmed, delivery: "seen" },
    ];
    let release!: (records: readonly OutgoingEvent[]) => void;
    const storage: OutboxStorage = {
      load: () =>
        asyncLoad
          ? new Promise((resolve) => {
              release = resolve;
            })
          : records,
      save: (next) => {
        records = structuredClone(next);
      },
    };
    const h = setup({ outboxStorage: storage });
    const view = h.session.observe(filters);
    h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
    if (!asyncLoad) expect(view.snapshot().events).toHaveLength(2);
    h.emit([roster(relay, "a", [], 11)]);
    expect(view.snapshot().events).toEqual([]);
    h.emit([roster(relay, "a", [viewer.pubkey], 12)]);
    if (asyncLoad) release(records);
    await flush();
    assert.exists(h.session.outbox);
    expect(h.session.outbox.snapshot()).toMatchObject([
      {
        event: { id: pending.id },
        signed: { id: pending.id },
        delivery: "unknown",
      },
    ]);
    expect(view.snapshot().events.map((e) => e.id)).toEqual([pending.id]);
    expect(records.map((item) => item.event.id)).toEqual([pending.id]);
  },
);

it("global explicit denial purges all channel evidence but a transient error does not", async () => {
  const h = setup();
  h.emit([
    message(alice, "a", "private", 10),
    message(alice, "b", "private too", 10),
  ]);
  const view = h.session.observe(filters);
  h.session.channels.refreshList?.();
  h.next().fail(new Error("offline"));
  await flush();
  expect(view.snapshot().events).toHaveLength(2);
  h.session.channels.refreshList?.();
  h.next().fail(new Error("Relay read failed (403)"));
  await flush();
  expect(view.snapshot().events).toEqual([]);
  h.emit([message(alice, "b", "late", 11)]);
  expect(view.snapshot().events).toEqual([]);
});

it("an explicitly single-channel generic read denial revokes that channel too", async () => {
  const h = setup();
  h.emit([
    message(alice, "a", "private", 10),
    message(alice, "b", "other", 10),
  ]);
  const view = h.session.observe(filters);
  const read = h.session.read([{ kinds: [9], "#h": ["a"], limit: 20 }]);
  h.next().fail(new Error("Relay read failed (403)"));
  await expect(read).rejects.toThrow("403");
  expect(view.snapshot().events.map((e) => e.content)).toEqual(["other"]);
  expect(
    h.session
      .observe(filters)
      .snapshot()
      .events.map((e) => e.content),
  ).toEqual(["other"]);
});

it("a mixed-reference ID view cannot keep an edit after its denied parent is purged", () => {
  const h = setup();
  const a = message(alice, "a", "A", 10),
    b = message(alice, "b", "B", 10);
  const edit = signed(alice, {
    kind: 40003,
    content: "private edit",
    tags: [
      ["h", "b"],
      ["e", a.id],
      ["e", b.id],
    ],
  });
  h.emit([a, b, edit]);
  const view = h.session.observe([{ ids: [edit.id], limit: 1 }]);
  expect(view.snapshot().events).toHaveLength(1);
  h.emit([roster(relay, "a", [], 11)]);
  expect(view.snapshot().events).toEqual([]);
  h.emit([edit]);
  expect(view.snapshot().events).toEqual([]);
});

it("revoking a reference target removes its edit from an unrelated retained channel window", async () => {
  const h = setup();
  const a = message(alice, "a", "A", 10),
    b = message(alice, "b", "B", 10);
  const edit = signed(alice, {
    kind: 40003,
    created_at: 11,
    content: "private multi-target edit",
    tags: [
      ["h", "b"],
      ["e", a.id],
      ["e", b.id],
    ],
  });
  h.emit([a, b]);
  h.session.channels.ensure("b");
  h.next().respond([
    b,
    bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  h.emit([edit]);
  expect(h.session.channels.window("b").rows.map((r) => r.content)).toEqual([
    edit.content,
  ]);
  h.emit([roster(relay, "a", [], 12)]);
  expect(h.session.channels.window("b").rows.map((r) => r.content)).toEqual([
    "B",
  ]);
});

it("late persisted heads/profiles cannot repopulate after revoke and regrant", async () => {
  let release!: (records: import("./persistence").SavedHead[]) => void;
  const disk = {
    read: () =>
      new Promise<import("./persistence").SavedHead[]>((resolve) => {
        release = resolve;
      }),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    retain: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const h = setup({ prepared: true, persistence: disk });
  h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
  h.session.channels.ensure("a");
  const stale = h.next();
  const oldLoad = release;
  h.emit([roster(relay, "a", [], 11)]);
  h.emit([roster(relay, "a", [viewer.pubkey], 12)]);
  oldLoad([
    {
      channelId: "a",
      savedAt: Date.now(),
      events: [
        message(alice, "a", "private disk", 10),
        bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ],
      profiles: [profile(alice, { name: "Private disk identity" })],
    },
  ]);
  stale.respond([
    message(alice, "a", "private read", 10),
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window("a").rows).toEqual([]);
  expect(h.session.profiles.snapshot().size).toBe(0);
  expect(h.session.observe(filters).snapshot().events).toEqual([]);
  expect(disk.retain).toHaveBeenCalledWith([]);
  expect(disk.clear).not.toHaveBeenCalled();
});

/** Opens `channelId` with one message from `author` and loads their profile. */
async function openNamed(
  h: ReturnType<typeof setup>,
  channelId: string,
  author: Key,
) {
  h.session.channels.ensure(channelId);
  h.next().respond([
    message(author, channelId, "hello", 10),
    bounds(relay, channelId, "head", { has_more: false, next_cursor: null }),
  ]);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([profile(author, { name: channelId })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(author.pubkey)?.name).toBe(
      channelId,
    ),
  );
}
const profileRead = (key: Key) => [
  { kinds: [0], authors: [key.pubkey], limit: 500 },
];

it("rereads a retained window's names after another channel's roster revokes access", async () => {
  const h = setup();
  h.emit(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey], 10)));
  await openNamed(h, "b", alice);
  h.emit([roster(relay, "a", [], 11)]);
  expect(h.session.profiles.snapshot().size).toBe(0);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const reread = h.next();
  expect(reread.filters).toEqual(profileRead(alice));
  reread.respond([profile(alice, { name: "Alice again" })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice again",
    ),
  );
});

it("a denied read's second profile clear does not abort the retained window's reread", async () => {
  const h = setup();
  h.emit(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey], 10)));
  await openNamed(h, "b", alice);
  h.session.channels.ensure("a");
  h.next().fail(new Error("Relay read failed (403)"));
  await vi.waitFor(() =>
    expect(h.session.channels.window("a").status).toBe("error"),
  );
  expect(h.session.profiles.snapshot().size).toBe(0);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const reread = h.next();
  expect(reread.signal?.aborted).toBe(false);
  expect(reread.filters).toEqual(profileRead(alice));
  reread.respond([profile(alice, { name: "Alice again" })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice again",
    ),
  );
  // Background reads are serial: a second live read surfaces only now.
  await flush();
  expect(h.pending).toEqual([]);
});

it("does not reread names whose only evidence was in the revoked channel", async () => {
  const h = setup();
  h.emit(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey], 10)));
  await openNamed(h, "b", bob);
  await openNamed(h, "a", alice);
  // A thread on the revoked channel is Carol's only evidence.
  const root = message(alice, "a", "root", 11);
  h.emit([
    root,
    message(alice, "a", "reply", 12, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
      ["p", carol.pubkey],
    ]),
  ]);
  const thread = h.session.thread("a", root.id);
  expect(thread.snapshot().replies[0]?.mentions).toEqual([carol.pubkey]);
  h.emit([roster(relay, "a", [], 13)]);
  expect(h.session.profiles.snapshot().size).toBe(0);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const reread = h.next();
  expect(reread.filters).toEqual(profileRead(bob));
  reread.respond([profile(bob, { name: "Bob again" })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(bob.pubkey)?.name).toBe(
      "Bob again",
    ),
  );
  // Background reads are serial: an Alice or Carol read queued behind Bob's surfaces only now.
  await flush();
  expect(h.pending).toEqual([]);
});

it("rereads a mounted thread's reply-only mention after another channel's roster revokes access", async () => {
  const h = setup();
  h.emit(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey], 10)));
  await openNamed(h, "b", alice);
  const root = message(alice, "b", "root", 11);
  h.emit([
    root,
    message(bob, "b", "reply", 12, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
      ["p", carol.pubkey],
    ]),
  ]);
  const thread = h.session.thread("b", root.id);
  expect(thread.snapshot().replies.map((row) => row.mentions)).toEqual([
    [carol.pubkey],
  ]);
  void h.session.profiles.ensure([carol.pubkey]);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([profile(carol, { name: "Carol" })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(carol.pubkey)?.name).toBe("Carol"),
  );
  h.emit([roster(relay, "a", [], 13)]);
  expect(h.session.profiles.snapshot().size).toBe(0);
  // The window rows name only Alice; Bob and Carol come from the thread.
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const window = h.next();
  expect(window.filters).toEqual(profileRead(alice));
  window.respond([profile(alice, { name: "Alice again" })]);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const reread = h.next();
  expect(reread.filters).toEqual([
    { kinds: [0], authors: [bob.pubkey, carol.pubkey].sort(), limit: 500 },
  ]);
  reread.respond([profile(carol, { name: "Carol again" })]);
  await vi.waitFor(() =>
    expect(h.session.profiles.snapshot().get(carol.pubkey)?.name).toBe(
      "Carol again",
    ),
  );
});

it("an ambiguous multi-channel read failure does not revoke unrelated evidence", async () => {
  const h = setup();
  h.emit([message(alice, "a", "A", 10), message(alice, "b", "B", 10)]);
  const read = h.session.read([{ kinds: [9], "#h": ["a", "b"], limit: 20 }]);
  h.next().fail(new Error("Relay read failed (403)"));
  await expect(read).rejects.toThrow("403");
  expect(h.session.observe(filters).snapshot().events).toHaveLength(2);
});

// Independent regression probes contributed by Brain.
it("profile purge subscribers cannot read stale denied owned views", () => {
  const h = setup();
  const secret = message(alice, "a", "secret", 10);
  h.emit([secret, profile(alice, { name: "Private identity" })]);
  const view = h.session.observe([{ kinds: [9], limit: 20 }]);
  const exposed: string[] = [];
  h.session.profiles.subscribe(() =>
    exposed.push(...view.snapshot().events.map((e) => e.id)),
  );
  h.emit([roster(relay, "a", [], 12)]);
  expect(view.snapshot().events).toEqual([]);
  expect(exposed).toEqual([]);
});

it("first owned-view purge subscriber cannot read a second stale denied view", () => {
  const h = setup();
  const secret = message(alice, "a", "secret", 10);
  h.emit([secret]);
  const first = h.session.observe([{ kinds: [9], limit: 20 }]);
  const second = h.session.observe([{ ids: [secret.id], limit: 1 }]);
  const exposed: string[] = [];
  first.subscribe(() =>
    exposed.push(...second.snapshot().events.map((e) => e.id)),
  );
  h.emit([roster(relay, "a", [], 12)]);
  expect(first.snapshot().events).toEqual([]);
  expect(second.snapshot().events).toEqual([]);
  expect(exposed).toEqual([]);
});

it.each([403, 500])(
  "complete roster omission still revokes when optional metadata fails (%s), without revoking surviving membership",
  async (code) => {
    const h = setup();
    const secret = message(alice, "a", "secret", 10);
    h.emit([roster(relay, "a", [viewer.pubkey], 10), secret]);
    const view = h.session.observe([{ kinds: [9], limit: 20 }]);
    h.session.channels.refreshList?.();
    h.next().respond([roster(relay, "b", [viewer.pubkey], 11)]);
    await flush();
    const metadata = h.next();
    expect(metadata.filters[0]?.kinds).toEqual([39000]);
    metadata.fail(new Error(`Relay read failed (${code})`));
    await flush();
    expect(h.session.channels.list().status).toBe("error");
    expect(h.session.channels.list().channels.map((c) => c.id)).toEqual(["b"]);
    expect(view.snapshot().events).toEqual([]);
  },
);

it("roster completeness does not overwrite a newer live grant while metadata is pending", async () => {
  const h = setup();
  h.session.channels.refreshList?.();
  h.next().respond([roster(relay, "b", [viewer.pubkey], 11)]);
  await flush();
  const details = h.next();
  h.emit([
    roster(relay, "a", [viewer.pubkey], 12),
    message(alice, "a", "newly granted", 13),
  ]);
  const view = h.session.observe([{ kinds: [9], limit: 20 }]);
  expect(view.snapshot().events).toHaveLength(1);
  details.respond([metadata(relay, "b", "B", 11)]);
  await flush();
  expect(view.snapshot().events.map((e) => e.content)).toEqual([
    "newly granted",
  ]);
});

it("channel-window purge subscriber cannot read another denied channel window", () => {
  const h = setup();
  h.emit([
    roster(relay, "a", [viewer.pubkey], 10),
    roster(relay, "b", [viewer.pubkey], 10),
  ]);
  h.session.channels.ensure("a");
  h.session.channels.ensure("b");
  h.emit([
    message(alice, "a", "secret-a", 11),
    message(alice, "b", "secret-b", 11),
  ]);
  expect(h.session.channels.window("a").rows.map((e) => e.content)).toEqual([
    "secret-a",
  ]);
  expect(h.session.channels.window("b").rows.map((e) => e.content)).toEqual([
    "secret-b",
  ]);
  const exposed: string[] = [];
  h.session.channels.subscribeWindow("a", () =>
    exposed.push(...h.session.channels.window("b").rows.map((e) => e.content)),
  );
  h.emit([roster(relay, "a", [], 12), roster(relay, "b", [], 12)]);
  expect(h.session.channels.window("a").rows).toEqual([]);
  expect(h.session.channels.window("b").rows).toEqual([]);
  expect(exposed).toEqual([]);
});

it("complete roster does not overwrite a signed grant received after the roster request began", async () => {
  const h = setup();
  h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
  h.session.channels.refreshList?.();
  const request = h.next();
  h.emit([
    roster(relay, "a", [viewer.pubkey], 12),
    message(alice, "a", "fresh grant", 13),
  ]);
  request.respond([
    roster(relay, "b", [viewer.pubkey], 11),
    metadata(relay, "b", "B"),
  ]);
  await flush();
  expect(
    h.session
      .observe(filters)
      .snapshot()
      .events.map((e) => e.content),
  ).toEqual(["fresh grant"]);
});

it("all channel-list and profile snapshots are committed before a revocation callback", () => {
  const h = setup();
  h.emit([
    roster(relay, "a", [viewer.pubkey], 10),
    metadata(relay, "a", "Private channel"),
    message(alice, "a", "secret", 10),
  ]);
  const view = h.session.observe(filters);
  const exposed: string[] = [];
  view.subscribe(() =>
    exposed.push(...h.session.channels.list().channels.map((c) => c.name)),
  );
  h.emit([roster(relay, "a", [], 12)]);
  expect(exposed).toEqual([]);
});

it("a reentrant fresh grant cannot be overwritten by the enclosing revocation commit", () => {
  const h = setup();
  h.emit([
    roster(relay, "a", [viewer.pubkey], 10),
    message(alice, "a", "old", 10),
  ]);
  const view = h.session.observe(filters);
  let regranted = false;
  view.subscribe(() => {
    if (regranted) return;
    regranted = true;
    h.emit([
      roster(relay, "a", [viewer.pubkey], 13),
      message(alice, "a", "new", 14),
    ]);
  });
  h.emit([roster(relay, "a", [], 12)]);
  expect(h.session.channels.list().channels.map((c) => c.id)).toEqual(["a"]);
  expect(view.snapshot().events.map((e) => e.content)).toEqual(["new"]);
});

it("a profile subscriber cannot restore a persisted head after revoking and regranting during hydration", async () => {
  const disk = {
    read: vi
      .fn()
      .mockResolvedValueOnce([
        {
          channelId: "a",
          savedAt: Date.now(),
          events: [
            message(alice, "a", "stale disk", 10),
            bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
          ],
          profiles: [profile(alice, { name: "Private disk identity" })],
        },
      ])
      .mockResolvedValue([]),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    retain: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const h = setup({ prepared: true, persistence: disk });
  let revoked = false;
  h.session.profiles.subscribe(() => {
    if (revoked || !h.session.profiles.snapshot().size) return;
    revoked = true;
    h.emit([roster(relay, "a", [], 12)]);
    h.emit([roster(relay, "a", [viewer.pubkey], 13)]);
  });
  h.emit([roster(relay, "a", [viewer.pubkey], 10)]);
  await vi.waitFor(() => expect(revoked).toBe(true));
  await flush();
  expect(h.diagnostics().heads.entries).toBe(0);
  h.session.channels.ensure("a");
  expect(h.session.channels.window("a").rows).toEqual([]);
});
