import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { DiscoveryState } from "./discovery";
import { ReadError } from "./errors";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "./testing";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";

const publicMetadata = (
  relay: Key,
  id: string,
  tags: string[][] = [],
  time = 1700000000,
) =>
  signed(relay, {
    kind: 39000,
    content: "",
    created_at: time,
    tags: [
      ["d", id],
      ["name", `Open ${id}`],
      ["public"],
      ["t", "stream"],
      ...tags,
    ],
  });
const search = [
  {
    kinds: [9, 40002],
    search: "crew",
    search_mode: "prefix" as const,
    limit: 20,
  },
];

it("requires explicit relay public evidence; keeps membership and loss/replay separate", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.retain(new Set(), new Map());
  state.accept(publicMetadata(viewer, "forged"));
  state.accept(
    signed(relay, { kind: 39000, content: "", tags: [["d", "missing"]] }),
  );
  for (const [id, tags] of [
    ["private", [["private"]]],
    ["hidden", [["hidden"]]],
    ["dm", [["t", "dm"]]],
  ] as const) {
    state.accept(
      publicMetadata(
        relay,
        id,
        tags.map((tag) => [...tag]),
      ),
    );
    expect(state.get(id)).toBeUndefined();
  }
  expect(state.get("forged")).toBeUndefined();
  expect(state.get("missing")).toBeUndefined();
  const open = publicMetadata(relay, "open");
  state.accept(open);
  expect(state.get("open")).toMatchObject({ readOnly: true });
  expect(state.channels()).toEqual([]);
  expect(state.canParticipate("open")).toBe(false);
  state.accept(roster(relay, "open", []));
  expect(state.canAccess("open")).toBe(true);
  const joined = roster(relay, "open", [viewer.pubkey], 1700000001);
  state.accept(joined);
  expect(state.channels()).toHaveLength(1);
  state.accept(roster(relay, "open", [], 1700000002));
  expect(state.canAccess("open")).toBe(false);
  state.accept(open);
  state.accept(joined);
  expect(state.canAccess("open")).toBe(false);
  state.accept(roster(relay, "open", [viewer.pubkey], 1700000003));
  expect(state.canAccess("open")).toBe(true);
  state.denyAll();
  state.accept(open);
  expect(state.canAccess("open")).toBe(false);
});

it("preserves one server ranking above 128 joined channels and opens a public exact reply read-only", async () => {
  const viewer = keypair(),
    relay = keypair();
  const joined = Array.from({ length: 129 }, (_, i) =>
    roster(relay, `joined-${i}`, [viewer.pubkey]),
  );
  const root = message(viewer, "open", "root", 1700000000);
  const reply = message(viewer, "open", "crew reply", 1700000001, [
    ["e", root.id, "", "reply"],
  ]);
  const other = message(viewer, "joined-0", "crew joined", 1700000002);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (
        filters.some((filter) => filter.kinds?.includes(39002) && !filter["#d"])
      )
        return Promise.resolve(joined);
      if (
        filters.some(
          (filter) =>
            filter.kinds?.includes(39000) && !filter["#d"]?.includes("open"),
        )
      )
        return Promise.resolve([publicMetadata(relay, "joined-0")]);
      return wire.transport.query(filters, signal);
    },
  });
  try {
    owner.session.channels.ensureList();
    await flush();
    expect(owner.session.channels.list().channels).toHaveLength(129);
    const read = owner.session.read(search);
    await flush();
    const query = wire.next();
    expect(query.filters[0]?.["#h"]).toBeUndefined();
    query.respond([reply, other]);
    await flush();
    const metadata = wire.next();
    expect(metadata.filters).toMatchObject([
      { kinds: [39000], "#d": ["open"], limit: 2 },
      { kinds: [39002], "#d": ["open"], "#p": [viewer.pubkey], limit: 2 },
    ]);
    metadata.respond([publicMetadata(relay, "open")]);
    expect((await read).map((item) => item.id)).toEqual([reply.id, other.id]);
    expect(owner.session.channels.list().channels).toHaveLength(129);
    expect(owner.session.channels.get?.("open")).toMatchObject({
      readOnly: true,
      name: "Open open",
    });
    expect(() => owner.session.messages.send("open", "not joined")).toThrow(
      "You don’t have write access to this conversation.",
    );
    expect(() =>
      owner.session.messages.reply("open", root.id, "not joined"),
    ).toThrow("You don’t have write access to this conversation.");
    expect(() => owner.session.messages.react(reply.id, "👍")).toThrow(
      "You don’t have write access to this conversation.",
    );
    expect(() =>
      owner.session.messages.edit(reply.id, "not joined", reply.id),
    ).toThrow("You don’t have write access to this conversation.");
    const thread = owner.session.thread("open", reply.id, { exact: true });
    const opening = thread.refresh();
    // Exact target, overlays, ancestry, traversal: all use the existing owner.
    for (let i = 0; i < 8; i++) {
      await flush();
      if (!wire.pending.length) break;
      const request = wire.next();
      const filter = request.filters[0];
      request.respond(
        filter?.ids?.includes(reply.id)
          ? [reply]
          : filter?.ids?.includes(root.id)
            ? [root]
            : filter?.depth_limit
              ? [reply]
              : [],
      );
    }
    await opening;
    expect(thread.snapshot().target?.id).toBe(reply.id);
    expect(thread.snapshot().root?.id).toBe(root.id);
    thread.dispose();
  } finally {
    owner.dispose();
  }
});

it("resolves public authority for operator-only global reads without widening visibility", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  const filters = [
    {
      kinds: [9],
      authors: [viewer.pubkey],
      since: 1700000000,
      limit: 20,
    },
  ];
  try {
    const read = owner.session.read(filters).catch((error: unknown) => error);
    await flush();
    const query = wire.next();
    expect(query.filters[0]).not.toHaveProperty("search");
    const publicHit = message(viewer, "open", "visible", 1700000001);
    const privateHit = message(viewer, "private", "hidden", 1700000002);
    query.respond([publicHit, privateHit]);
    await flush();
    const authority = wire.next();
    expect(authority.filters).toMatchObject([
      { kinds: [39000], "#d": ["open", "private"] },
      { kinds: [39002], "#d": ["open", "private"], "#p": [viewer.pubkey] },
    ]);
    authority.respond([
      publicMetadata(relay, "open"),
      publicMetadata(relay, "private", [["private"]]),
    ]);
    // Private metadata changes authority mid-read. The first request is fenced,
    // not silently presented as a complete page of public results.
    expect(await read).toBeInstanceOf(DOMException);
    expect(owner.session.channels.get?.("private")).toBeUndefined();
    const retry = owner.session.read(filters);
    await flush();
    wire.next().respond([publicHit]);
    await flush();
    wire.next().respond([publicMetadata(relay, "open")]);
    expect((await retry).map((event) => event.id)).toEqual([publicHit.id]);
  } finally {
    owner.dispose();
  }
});

it.each(["cancel", "clear", "dispose"])(
  "fences delayed metadata after %s",
  async (action) => {
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession(wire.transport);
    const controller = new AbortController();
    const read = owner.session
      .read(search, { signal: controller.signal })
      .catch((error: unknown) => error);
    await flush();
    wire.next().respond([message(viewer, "open", "crew", 1700000000)]);
    await flush();
    const metadata = wire.next();
    if (action === "cancel") controller.abort();
    if (action === "clear") await owner.clearCache();
    if (action === "dispose") owner.dispose();
    metadata.respond([publicMetadata(relay, "open")]);
    expect(await read).toBeInstanceOf(Error);
    expect(owner.session.channels.get?.("open")).toBeUndefined();
    owner.dispose();
  },
);

it("rejects missing/forged/private evidence and purges prior public content on access loss", async () => {
  const viewer = keypair(),
    relay = keypair();
  const rows = ["open", "private", "missing", "forged"].map((id) =>
    message(viewer, id, "crew", 1700000000),
  );
  let metadata: RelayEvent[] = [
    publicMetadata(relay, "open"),
    publicMetadata(relay, "private", [["private"]]),
    publicMetadata(viewer, "forged"),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39002) && !filter["#d"])
          ? []
          : filters.some((filter) => filter.search)
            ? rows
            : metadata,
      );
    },
  });
  try {
    owner.session.channels.ensureList();
    await flush();
    expect((await owner.session.read(search)).map((item) => item.id)).toEqual([
      rows[0]?.id,
    ]);
    const view = owner.session.observe([
      { kinds: [9], "#h": ["open"], limit: 20 },
    ]);
    expect(view.snapshot().events).toHaveLength(1);
    metadata = [publicMetadata(relay, "open", [["private"]], 1700000001)];
    await owner.session.channels.resolve?.(["open"]);
    expect(view.snapshot().events).toEqual([]);
    expect(owner.session.channels.get?.("open")).toBeUndefined();
    view.dispose();
    metadata = [publicMetadata(relay, "open")];
    await owner.session.channels.resolve?.(["open"]);
    expect(owner.session.channels.get?.("open")).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("surfaces bounded metadata failures instead of silently returning an empty page", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const viewer = keypair(),
    relay = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search))
        return Promise.resolve([message(viewer, "open", "crew", 1700000000)]);
      return Promise.reject(
        new ReadError("unavailable", "metadata unavailable"),
      );
    },
  });
  try {
    const rejected = expect(owner.session.read(search)).rejects.toThrow(
      "metadata unavailable",
    );
    await vi.advanceTimersByTimeAsync(5250);
    await rejected;
  } finally {
    owner.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("keeps search-only channels out of live interests/warming/disk; demands only opened previews and purges live loss", async () => {
  const viewer = keypair(),
    relay = keypair();
  let live: LiveCallbacks | undefined;
  const update = vi.fn();
  const write = vi.fn(async () => {});
  const seen: import("./events").ReadFilter[] = [];
  const rows = ["open", "other"].map((id) =>
    message(viewer, id, "crew", 1700000000),
  );
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update, prioritize() {}, retry() {}, dispose() {} };
      },
      async query(filters) {
        seen.push(...filters);
        const filter = filters[0];
        if (filter?.search) return rows;
        if (filter?.kinds?.includes(39000))
          return (filter["#d"] ?? []).map((id) => publicMetadata(relay, id));
        if (filter?.top_level)
          return [
            ...rows.slice(0, 1),
            bounds(relay, "open", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [];
      },
    },
    {
      prepared: true,
      persistence: {
        read: async () => [],
        write,
        retain: async () => {},
        remove: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  try {
    owner.session.channels.ensureList();
    await flush();
    await owner.session.read(search);
    expect(update.mock.lastCall?.[0]).toEqual([]);
    owner.session.channels.warm?.([]);
    await flush();
    expect(seen.some((filter) => filter.top_level)).toBe(false);
    owner.session.channels.ensure("open");
    await flush();
    expect(update.mock.lastCall?.[0]).toEqual(["open"]);
    expect(owner.session.channels.list().channels).toEqual([]);
    expect(owner.session.channels.window("open").rows).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    const view = owner.session.observe([
      { kinds: [9], "#h": ["open"], limit: 20 },
    ]);
    live?.receive([publicMetadata(relay, "open", [["private"]], 1700000001)]);
    expect(view.snapshot().events).toEqual([]);
    expect(owner.session.channels.window("open").rows).toEqual([]);
    expect(update.mock.lastCall?.[0]).toEqual([]);
    view.dispose();
    await owner.clearCache();
    expect(update.mock.lastCall?.[0]).toEqual([]);
  } finally {
    owner.dispose();
  }
});

it("fails closed on the returned-channel cap and metadata capacity without evicting denial evidence", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  try {
    await expect(
      owner.session.channels.resolve?.(
        Array.from({ length: 129 }, (_, i) => `c${i}`),
      ),
    ).rejects.toThrow("Too many");
    expect(wire.pending).toHaveLength(0);
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey, 1);
    state.retain(new Set(), new Map());
    state.accept(publicMetadata(relay, "one"));
    state.deny("one");
    expect(state.accept(publicMetadata(relay, "two"))).toBe(false);
    expect(state.get("one")).toBeUndefined();
    expect(state.get("two")).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("does not revoke newer live public evidence when an older metadata lookup omits it", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live?.receive([publicMetadata(relay, "open")]);
    const resolve = owner.session.channels.resolve?.(["open"]);
    await flush();
    const pending = wire.next();
    live?.receive([publicMetadata(relay, "open", [], 1700000001)]);
    pending.respond([]);
    await resolve;
    expect(owner.session.channels.get?.("open")).toMatchObject({
      readOnly: true,
    });
    const missing = owner.session.channels.resolve?.(["open"]);
    await flush();
    wire.next().respond([]);
    await missing;
    expect(owner.session.channels.get?.("open")).toBeUndefined();
    live?.receive([publicMetadata(relay, "open", [], 1700000001)]);
    expect(owner.session.channels.get?.("open")).toBeUndefined();
    live?.receive([publicMetadata(relay, "open", [], 1700000002)]);
    expect(owner.session.channels.get?.("open")).toMatchObject({
      readOnly: true,
    });
  } finally {
    owner.dispose();
  }
});

it.each(["private", "public", "dm"])(
  "resolves a %s member omitted from a capped roster using bounded signed membership",
  async (visibility) => {
    const viewer = keypair(),
      relay = keypair();
    const memberships = Array.from({ length: 500 }, (_, i) =>
      roster(relay, `c${i}`, [viewer.pubkey]),
    ).sort((a, b) => a.id.localeCompare(b.id));
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters, signal) {
        if (filters.some((filter) => filter.search))
          return [message(viewer, "omitted", "crew", 1700000000)];
        const rosterFilter = filters.find(
          (filter) => filter.kinds?.includes(39002) && !filter["#d"],
        );
        if (rosterFilter)
          return rosterFilter.until === undefined &&
            rosterFilter.before_id === undefined
            ? memberships
            : wire.transport.query(filters, signal);
        if (filters.some((filter) => filter["#d"]?.includes("omitted")))
          return [
            publicMetadata(
              relay,
              "omitted",
              visibility === "public"
                ? []
                : visibility === "dm"
                  ? [["private"], ["hidden"], ["t", "dm"]]
                  : [["private"]],
            ),
            roster(relay, "omitted", [viewer.pubkey]),
          ];
        return [];
      },
    });
    try {
      owner.session.channels.ensureList();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      const continuation = wire.next();
      try {
        expect(continuation.filters).toEqual([
          {
            kinds: [39002],
            "#p": [viewer.pubkey],
            limit: 500,
            until: memberships.at(-1)?.created_at,
            before_id: memberships.at(-1)?.id,
          },
        ]);
        expect(owner.session.channels.list().channels).toHaveLength(500);
        expect(owner.session.channels.list().coverage).toBe("partial");
        expect(owner.session.live.snapshot().roster.state).toBe("pending");
        expect(owner.session.channels.get?.("omitted")).toBeUndefined();
        const result = await owner.session.read(search);
        expect(result).toHaveLength(1);
        expect(
          owner.session.channels.get?.("omitted")?.readOnly,
        ).toBeUndefined();
        expect(
          owner.session.channels
            .list()
            .channels.some((channel) => channel.id === "omitted"),
        ).toBe(true);
      } finally {
        continuation.respond([]);
      }
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe("verified"),
      );
      expect(owner.session.channels.list().coverage).toBeUndefined();
      expect(
        owner.session.channels
          .list()
          .channels.some((channel) => channel.id === "omitted"),
      ).toBe(true);
    } finally {
      owner.dispose();
    }
  },
);

it("a restricted route revalidates the nonmember ID and purges inaccessible preview content", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live?.receive([
      publicMetadata(relay, "open"),
      message(viewer, "open", "crew", 1700000000),
    ]);
    const view = owner.session.observe([
      { kinds: [9], "#h": ["open"], limit: 20 },
    ]);
    const notifications = vi.fn();
    const stop = owner.session.channels.subscribeList(notifications);
    expect(view.snapshot().events).toHaveLength(1);
    live?.state({
      status: "connected",
      routes: [
        {
          id: "channel-open",
          channelId: "open",
          status: "error",
          replay: "unknown",
          error: "restricted: channel access revoked",
        },
      ],
    });
    await flush();
    const metadata = wire.pending.find((request) =>
      request.filters.some((filter) => filter.kinds?.includes(39000)),
    );
    expect(metadata?.filters[0]?.["#d"]).toEqual(["open"]);
    metadata?.respond([]);
    await flush();
    expect(owner.session.channels.get?.("open")).toBeUndefined();
    expect(view.snapshot().events).toEqual([]);
    expect(notifications).toHaveBeenCalled();
    stop();
    view.dispose();
  } finally {
    owner.dispose();
  }
});

it.each([false, true])(
  "completes authority-only self-revocation but fences mixed content reads (content=%s)",
  async (content) => {
    const viewer = keypair(),
      relay = keypair();
    let events: RelayEvent[] = [publicMetadata(relay, "open")];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => events,
    });
    try {
      await owner.session.channels.resolve?.(["open"]);
      expect(owner.session.channels.get?.("open")).toMatchObject({
        readOnly: true,
      });
      events = [publicMetadata(relay, "open", [["private"]], 1700000001)];
      if (content) events.push(message(viewer, "open", "hidden", 1700000000));
      const read = owner.session.read([
        { kinds: [39000], "#d": ["open"], limit: 20 },
        ...(content ? [{ kinds: [9], "#h": ["open"], limit: 20 }] : []),
      ]);
      if (content) await expect(read).rejects.toThrow("Stale relay read");
      else await expect(read).resolves.toEqual([]);
      expect(owner.session.channels.get?.("open")).toBeUndefined();
      const view = owner.session.observe([
        { kinds: [9], "#h": ["open"], limit: 20 },
      ]);
      expect(view.snapshot().events).toEqual([]);
      view.dispose();
    } finally {
      owner.dispose();
    }
  },
);
