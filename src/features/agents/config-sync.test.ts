import { describe, expect, it, vi } from "vitest";
import type { VerifiedEvent } from "nostr-tools";
import type {
  ArtifactSyncFilter,
  ArtifactSyncSnapshot,
  ArtifactSyncView,
} from "../relay/artifact-sync";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, artifactTemplate } from "./agent-config-artifacts";
import {
  type ConfigFeed,
  createConfigSync,
  DISCOVERY_PAGE,
} from "./config-sync";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const relay = keypair();
const agent = keypair().pubkey;
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const binding = { family: "agent-config", subject: agent, channel } as const;
const subject = (type: Subject["type"]): Subject => ({
  owner: owner.pubkey,
  community: "c",
  subject: agent,
  channel,
  type,
});
const instructions = subject("buzz.agent.instructions");
const settings = subject("buzz.agent.settings");

async function revision(
  text: string,
  prev?: string,
  type: Subject["type"] = "buzz.agent.instructions",
  home = channel,
) {
  const d = await artifactD(type, channel);
  return signed(
    owner,
    artifactTemplate({
      channel: home,
      type,
      d,
      op: prev ? "update" : "create",
      title: "Agent instructions",
      content: JSON.stringify(
        type === "buzz.agent.settings"
          ? { version: 1, settings: {} }
          : { version: 1, text },
      ),
      ...(prev ? { prev } : {}),
    }),
  );
}

/** Relay-signed channel state the confirm read returns. */
const metadata = (tags: string[][] = []) =>
  signed(relay, { kind: 39000, content: "", tags: [["d", channel], ...tags] });
const members = (pubkeys = [owner.pubkey]) =>
  signed(relay, {
    kind: 39002,
    content: "",
    tags: [["d", channel], ...pubkeys.map((p) => ["p", p])],
  });

/** A session whose syncs, reads and connections the test drives. */
function controlled(
  answer: (filter: ReadFilter) => RelayEvent[] | Promise<RelayEvent[]>,
) {
  type Fake = ArtifactSyncView & {
    filter: ArtifactSyncFilter;
    open: boolean;
    set(snapshot: ArtifactSyncSnapshot): void;
  };
  const views: Fake[] = [];
  const reads: ReadFilter[] = [];
  const connections = new Set<() => void>();
  const follows = new Set<{
    channels: readonly string[];
    listener: (events: readonly RelayEvent[]) => void;
    revoked: (channels: readonly string[]) => void;
  }>();
  const state = {
    channel: (): RelayEvent[] | Promise<RelayEvent[]> => [
      metadata(),
      members(),
    ],
    discovery: (_filter: ReadFilter): RelayEvent[] => [],
    /** False: the session has no sync capacity left. */
    capacity: true,
  };
  const feed: ConfigFeed = {
    relayAuthor: relay.pubkey,
    connected(listener) {
      connections.add(listener);
      return () => connections.delete(listener);
    },
    read: async ([filter]) => {
      if (!filter) return [];
      reads.push(filter);
      if (filter["#P"]) return state.discovery(filter);
      if (filter["#d"] && filter.kinds?.includes(39000)) return state.channel();
      return answer(filter);
    },
    sync(filter) {
      if (!state.capacity)
        throw new Error("Artifact sync capacity unavailable");
      const listeners = new Set<() => void>();
      let snapshot: ArtifactSyncSnapshot = { status: "loading", events: [] };
      const view: Fake = {
        filter,
        open: true,
        snapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {
          view.open = false;
        },
        set(next) {
          snapshot = next;
          for (const listener of listeners) listener();
        },
      };
      views.push(view);
      return view;
    },
    follow(channels, listener, revoked) {
      const follow = { channels, listener, revoked };
      follows.add(follow);
      return () => follows.delete(follow);
    },
  };
  /** A live revision, to each follow of its channel. */
  const emit = (event: RelayEvent) => {
    const h = event.tags.find(([name]) => name === "h")?.[1] ?? "";
    for (const follow of follows)
      if (follow.channels.includes(h)) follow.listener([event]);
  };
  const view = () => views.filter((v) => v.open).at(-1);
  const set = (
    status: ArtifactSyncSnapshot["status"],
    events: RelayEvent[] = [],
  ) => view()?.set({ status, events: events as VerifiedEvent[] });
  const reconnect = () => {
    for (const listener of connections) listener();
  };
  const artifactReads = () => reads.filter((f) => f.kinds?.includes(45010));
  return {
    feed,
    reads,
    artifactReads,
    state,
    views,
    view,
    set,
    reconnect,
    follows,
    emit,
  };
}

/** A promise the test resolves later. */
function held<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const hooks = () => ({
  history: vi.fn(),
  discovery: vi.fn(),
  roster: vi.fn(),
  problem: vi.fn(),
});

/** One bound channel whose first complete set held head A. Later lookups
 * return `setCurrent`'s events or throw `failWith`'s error. */
async function synced() {
  const a = await revision("A");
  let current: RelayEvent[] = [a];
  let fail: unknown;
  const relayFeed = controlled(() => {
    if (fail) throw fail;
    return current;
  });
  const store = new AgentConfigStore(memoryStorage());
  const spies = hooks();
  const sync = createConfigSync(
    store,
    relayFeed.feed,
    owner.pubkey,
    "c",
    spies,
  );
  const bound = sync.bind([binding]);
  await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
  relayFeed.set("live", [a]);
  await bound;
  expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  spies.history.mockClear();
  return {
    a,
    store,
    relayFeed,
    sync,
    ...spies,
    setCurrent: (events: RelayEvent[]) => {
      current = events;
    },
    failWith: (error: unknown) => {
      fail = error;
    },
  };
}

const archived = () => [metadata([["archived", "true"]]), members()];

describe("config sync over one NIP-AR sync", () => {
  it("opens one current-artifact sync over every bound channel", async () => {
    const relayFeed = controlled(() => []);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const other = "5f0c3a5e-1a1b-4c2d-9e8f-001122334455";
    void sync.bind([
      binding,
      { ...binding, subject: keypair().pubkey, channel: other },
    ]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    expect(relayFeed.views).toHaveLength(1);
    expect(relayFeed.view()?.filter).toEqual({
      artifact: "current",
      kinds: [45010],
      "#h": [other, channel].sort(),
    });
    // Unbinding narrows the filter, which takes a new sync.
    sync.unbind(other);
    await flush();
    expect(relayFeed.views.filter((v) => v.open)).toHaveLength(1);
    expect(relayFeed.view()?.filter["#h"]).toEqual([channel]);
  });

  it("a set reopened for a new binding confirms and rediscovers nothing already confirmed; a connection confirms each again", async () => {
    const { a, sync, relayFeed } = await synced();
    const other = "5f0c3a5e-1a1b-4c2d-9e8f-001122334455";
    const confirms = (id: string) =>
      relayFeed.reads.filter(
        (f) => f.kinds?.includes(39000) && f["#d"]?.[0] === id,
      ).length;
    const discoveries = () => relayFeed.reads.filter((f) => f["#P"]).length;
    expect(confirms(channel)).toBe(1);
    expect(discoveries()).toBe(1);
    const lookups = relayFeed.artifactReads().length;
    const bound = sync.bind([
      { ...binding, subject: keypair().pubkey, channel: other },
    ]);
    await vi.waitFor(() =>
      expect(relayFeed.view()?.filter["#h"]).toContain(other),
    );
    relayFeed.set("live", [a]);
    await bound;
    // Only the new binding's two artifacts are looked up.
    expect(relayFeed.artifactReads()).toHaveLength(lookups + 2);
    expect(confirms(channel)).toBe(1);
    expect(confirms(other)).toBe(1);
    expect(discoveries()).toBe(1);
    const third = "6a1d4b6f-2b2c-4d3e-8f90-112233445566";
    const rebound = sync.bind([
      { ...binding, subject: keypair().pubkey, channel: third },
    ]);
    await vi.waitFor(() =>
      expect(relayFeed.view()?.filter["#h"]).toContain(third),
    );
    // The connection dropped while that set loaded.
    relayFeed.reconnect();
    relayFeed.set("live", [a]);
    await rebound;
    expect(confirms(channel)).toBe(2);
    expect(confirms(other)).toBe(2);
    expect(confirms(third)).toBe(1);
  });

  it.each(["stale", "loading"] as const)(
    "a confirm answered after the sync goes %s never spares the next set its own",
    async (status) => {
      const a = await revision("A");
      const old = held<RelayEvent[]>();
      const relayFeed = controlled(() => []);
      let confirms = 0;
      relayFeed.state.channel = () =>
        ++confirms === 1 ? old.promise : archived();
      const store = new AgentConfigStore(memoryStorage());
      const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
      const bound = sync.bind([binding]);
      await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
      relayFeed.set("live", [a]);
      await vi.waitFor(() => expect(confirms).toBe(1));
      // Read before an archive, answered after the sync restarted.
      relayFeed.set(status);
      old.release([metadata(), members()]);
      await bound;
      relayFeed.set("live", [a]);
      await flush();
      expect(confirms).toBe(2);
      expect(store.instructions(instructions).ok).toBe(false);
    },
  );

  it("a restart while a set still installs confirms each binding again", async () => {
    const a = await revision("A");
    const other = "5f0c3a5e-1a1b-4c2d-9e8f-001122334455";
    // The first binding installs at once; lookups for the other hold the
    // set's install open.
    const lookup = held<RelayEvent[]>();
    const relayFeed = controlled((filter) =>
      filter["#h"]?.includes(other) ? lookup.promise : [],
    );
    let confirms = 0;
    relayFeed.state.channel = () =>
      ++confirms <= 2 ? [metadata(), members()] : archived();
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([
      binding,
      { ...binding, subject: keypair().pubkey, channel: other },
    ]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    await vi.waitFor(() => expect(relayFeed.artifactReads()).toHaveLength(3));
    expect(store.instructions(instructions).ok).toBe(true);
    relayFeed.set("loading");
    lookup.release([]);
    relayFeed.set("live", [a]);
    await bound;
    await vi.waitFor(() => expect(confirms).toBe(4));
    expect(store.instructions(instructions).ok).toBe(false);
  });

  it("installs nothing until the first complete set, then confirms the channel", async () => {
    const a = await revision("A");
    const relayFeed = controlled(() => []);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("loading", [a]);
    await flush();
    expect(relayFeed.reads).toEqual([]);
    expect(store.instructions(instructions).ok).toBe(false);
    relayFeed.set("live", [a]);
    await bound;
    expect(relayFeed.reads).toContainEqual(
      expect.objectContaining({
        kinds: [39000],
        authors: [relay.pubkey],
        "#d": [channel],
        limit: 1,
        consistency: "strong",
      }),
    );
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("keeps an edit that arrives while the set's confirm is out", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    const confirm = held<RelayEvent[]>();
    const relayFeed = controlled(() => []);
    relayFeed.state.channel = () => confirm.promise;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    relayFeed.set("live", [b]);
    confirm.release([metadata(), members()]);
    await bound;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
  });

  it("a set whose confirm returns after a newer set installed never replaces it", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    const confirm = held<RelayEvent[]>();
    const relayFeed = controlled(() => []);
    let confirms = 0;
    relayFeed.state.channel = () =>
      confirms++ === 0 ? confirm.promise : [metadata(), members()];
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    void sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    await flush();
    // The sync restarts and a newer complete set installs while A's is held.
    relayFeed.set("loading");
    relayFeed.set("live", [b]);
    await vi.waitFor(() =>
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" }),
    );
    confirm.release([metadata(), members()]);
    await flush();
    await flush();
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
  });

  it("a set's lookup from before a restart never denies what the newer set installed", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    const old = held<RelayEvent[]>();
    let holding = false;
    const relayFeed = controlled(() => {
      if (!holding) return [];
      holding = false;
      return old.promise;
    });
    const store = new AgentConfigStore(memoryStorage());
    const spies = hooks();
    const sync = createConfigSync(
      store,
      relayFeed.feed,
      owner.pubkey,
      "c",
      spies,
    );
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    await bound;
    // A restarted set that lacks the head looks it up, and is held.
    relayFeed.set("loading");
    holding = true;
    relayFeed.set("live", []);
    await vi.waitFor(() => expect(holding).toBe(false));
    try {
      relayFeed.set("loading");
      relayFeed.set("live", [b]);
      await vi.waitFor(() =>
        expect(store.instructions(instructions)).toEqual({
          ok: true,
          text: "B",
        }),
      );
    } finally {
      old.fail(new Error("Relay read failed (403)"));
    }
    await flush();
    await flush();
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(spies.problem).not.toHaveBeenCalled();
  });

  it("looks up by d what the set lacks, keeping deleted apart from unavailable", async () => {
    const a = await revision("A");
    const d = await artifactD("buzz.agent.instructions", channel);
    const deletion = signed(owner, {
      kind: 45010,
      content: "",
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", "buzz.agent.instructions"],
        ["op", "delete"],
        ["prev", a.id],
      ],
    });
    const relayFeed = controlled((f) => (f["#d"]?.[0] === d ? [deletion] : []));
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", []);
    await bound;
    expect(relayFeed.artifactReads()).toContainEqual(
      expect.objectContaining({ "#h": [channel], "#d": [d] }),
    );
    expect(store.state(instructions).state).toBe("deleted");
    expect(store.state(settings).state).toBe("unavailable");
  });

  it("installs a set head from another type as invalid, never present", async () => {
    const forged = signed(
      owner,
      artifactTemplate({
        channel,
        type: "buzz.agent.settings",
        d: await artifactD("buzz.agent.instructions", channel),
        op: "create",
        title: "Agent settings",
        content: JSON.stringify({ version: 1, settings: {} }),
      }),
    );
    const relayFeed = controlled(() => []);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [forged]);
    await bound;
    expect(store.state(instructions)).toMatchObject({
      state: "invalid",
      problem: "Artifact type mismatch",
    });
  });

  it("a live successor applies and reloads history; a non-successor rereads", async () => {
    const { a, store, relayFeed, history } = await synced();
    const b = await revision("B", a.id);
    relayFeed.set("live", [b]);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(history).toHaveBeenCalledTimes(1);
    const reads = relayFeed.artifactReads().length;
    relayFeed.set("live", [await revision("C", "f".repeat(64))]);
    await flush();
    expect(relayFeed.artifactReads().length).toBeGreaterThan(reads);
  });

  it("a head leaving the live set (deleted or moved) is reread by d", async () => {
    const { store, relayFeed, setCurrent } = await synced();
    setCurrent([]);
    const reads = relayFeed.artifactReads().length;
    relayFeed.set("live", []);
    await vi.waitFor(() =>
      expect(relayFeed.artifactReads().length).toBeGreaterThan(reads),
    );
    await vi.waitFor(() =>
      expect(store.state(instructions).state).not.toBe("present"),
    );
  });

  it("a redacted head is absent from the restarted set and stops being present", async () => {
    const { store, relayFeed, history, setCurrent } = await synced();
    setCurrent([]);
    // CLOSED resync: the sync keeps the old set as stale, then reloads.
    relayFeed.set("stale", [await revision("A")]);
    relayFeed.set("loading", []);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    relayFeed.set("live", []);
    await vi.waitFor(() =>
      expect(store.state(instructions).state).not.toBe("present"),
    );
    expect(history).toHaveBeenCalled();
  });

  it("stale and error keep the last confirmed state and report stale", async () => {
    const { store, relayFeed, problem } = await synced();
    relayFeed.set("stale", []);
    expect(problem).toHaveBeenCalledWith({ channel, kind: "stale" });
    relayFeed.set("error", []);
    relayFeed
      .view()
      ?.set({ status: "error", events: [], error: "error: quota" });
    expect(problem).toHaveBeenCalledWith({
      channel,
      kind: "stale",
      error: "error: quota",
    });
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("an error before any set settles bind with nothing installed", async () => {
    const relayFeed = controlled(() => [] as RelayEvent[]);
    const store = new AgentConfigStore(memoryStorage());
    const problem = vi.fn();
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c", {
      problem,
    });
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("error");
    await bound;
    expect(problem).toHaveBeenCalledWith({ channel, kind: "stale" });
    expect(store.instructions(instructions).ok).toBe(false);
    expect(relayFeed.artifactReads()).toHaveLength(0);
  });

  it("restricted rechecks each channel; one the owner left retires", async () => {
    const { store, relayFeed, discovery } = await synced();
    relayFeed.state.channel = () => [metadata(), members([agent])];
    relayFeed.set("restricted");
    await vi.waitFor(() =>
      expect(store.state(instructions).state).toBe("unavailable"),
    );
    expect(discovery).not.toHaveBeenCalled();
    await flush();
    expect(relayFeed.view()).toBeUndefined();
  });

  it("a channel archived since the last set retires on the next set's confirm", async () => {
    const { store, relayFeed, discovery } = await synced();
    relayFeed.state.channel = archived;
    relayFeed.set("loading");
    relayFeed.set("live", [await revision("A")]);
    await vi.waitFor(() =>
      expect(store.state(instructions).state).toBe("unavailable"),
    );
    expect(discovery).toHaveBeenCalled();
    await flush();
    expect(relayFeed.view()).toBeUndefined();
  });

  it("a denied confirm retires the binding, so the seeded head cannot start", async () => {
    const { store, relayFeed, problem } = await synced();
    relayFeed.state.channel = () => {
      throw new Error("Relay read failed (403)");
    };
    relayFeed.set("loading");
    relayFeed.set("live", []);
    await vi.waitFor(() =>
      expect(problem).toHaveBeenCalledWith({ channel, kind: "denied" }),
    );
    expect(store.instructions(instructions).ok).toBe(false);
  });

  it("reports a member change while the owner stays", async () => {
    const { relayFeed, roster } = await synced();
    relayFeed.state.channel = () => [
      metadata(),
      members([owner.pubkey, agent]),
    ];
    relayFeed.set("loading");
    relayFeed.set("live", [await revision("A")]);
    await vi.waitFor(() => expect(roster).toHaveBeenCalledWith(channel));
  });
});

describe("config sync without a sync", () => {
  it("unsupported falls back to finite reads, again on each connection", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    let current = [a];
    const relayFeed = controlled(() => current);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("unsupported");
    await bound;
    expect(relayFeed.view()).toBeUndefined();
    expect(relayFeed.artifactReads()[0]).toMatchObject({
      artifact: "current",
      "#h": [channel],
    });
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    current = [b];
    relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" }),
    );
  });

  it("advances heads from the bound channels' live revisions between connections", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    const c = await revision("C", b.id);
    const relayFeed = controlled(() => [a]);
    const store = new AgentConfigStore(memoryStorage());
    const spies = hooks();
    const sync = createConfigSync(
      store,
      relayFeed.feed,
      owner.pubkey,
      "c",
      spies,
    );
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("unsupported");
    await bound;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    relayFeed.emit(b);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(spies.history).toHaveBeenCalled();
    // One that skips a revision this device missed is read instead.
    const reads = relayFeed.artifactReads().length;
    const d = await revision("D", a.id);
    relayFeed.emit(d);
    await vi.waitFor(() =>
      expect(relayFeed.artifactReads().length).toBeGreaterThan(reads),
    );
    relayFeed.emit(c);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "C" });
    sync.dispose();
    expect(relayFeed.follows.size).toBe(0);
  });

  it("a finite read held while a live revision lands never rolls it back", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    let current: RelayEvent[] = [a];
    const pending = held<RelayEvent[]>();
    let hold = false;
    const relayFeed = controlled((filter) =>
      hold && filter.artifact === "current" ? pending.promise : current,
    );
    relayFeed.state.capacity = false;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    await sync.bind([binding]);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    hold = true;
    const reads = relayFeed.artifactReads().length;
    relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(relayFeed.artifactReads().length).toBeGreaterThan(reads),
    );
    current = [b];
    relayFeed.emit(b);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    pending.release([a]);
    await flush();
    await flush();
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
  });

  it.each([
    ["an archive", () => metadata([["archived", "true"]]), () => archived()],
    ["the owner's removal", () => members([]), () => [metadata(), members([])]],
  ])(
    "%s heard while following retires the binding once a confirm agrees",
    async (_, lost, now) => {
      const a = await revision("A");
      const relayFeed = controlled(() => [a]);
      relayFeed.state.capacity = false;
      const store = new AgentConfigStore(memoryStorage());
      const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
      await sync.bind([binding]);
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
      // Superseded: the channel's current pair still names the owner.
      for (const follow of relayFeed.follows) follow.listener([lost()]);
      await flush();
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
      relayFeed.state.channel = now;
      for (const follow of relayFeed.follows) follow.listener([lost()]);
      await vi.waitFor(() =>
        expect(store.instructions(instructions)).toMatchObject({
          ok: false,
          state: "unavailable",
        }),
      );
    },
  );

  /** A bound channel the relay has no sync for, following live. */
  async function following(
    answer: (
      filter: ReadFilter,
      a: RelayEvent,
    ) => RelayEvent[] | Promise<RelayEvent[]> = (_, a) => [a],
  ) {
    const a = await revision("A");
    const relayFeed = controlled((filter) => answer(filter, a));
    relayFeed.state.capacity = false;
    const store = new AgentConfigStore(memoryStorage());
    const spies = hooks();
    const sync = createConfigSync(
      store,
      relayFeed.feed,
      owner.pubkey,
      "c",
      spies,
    );
    await sync.bind([binding]);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    const revoke = () => {
      for (const follow of relayFeed.follows) follow.revoked([channel]);
    };
    const hear = (event: RelayEvent) => {
      for (const follow of relayFeed.follows) follow.listener([event]);
    };
    return { a, relayFeed, store, spies, revoke, hear };
  }

  it.each([
    [
      "a relay that refuses its state",
      (): RelayEvent[] => {
        throw new Error("Relay read failed (403)");
      },
    ],
    [
      "a relay that can't be reached",
      (): RelayEvent[] => {
        throw new Error("Relay unreachable");
      },
    ],
    ["a relay that no longer shows its state", (): RelayEvent[] => []],
  ])(
    "a followed channel the session no longer grants retires as denied, given %s",
    async (_, channelState) => {
      const f = await following();
      f.relayFeed.state.channel = channelState;
      f.revoke();
      await vi.waitFor(() =>
        expect(f.spies.problem).toHaveBeenCalledWith({
          channel,
          kind: "denied",
        }),
      );
      expect(f.store.instructions(instructions)).toMatchObject({
        ok: false,
        state: "unavailable",
      });
    },
  );

  it("starts nothing from a revoked channel until a confirm and a fresh read give it back", async () => {
    const f = await following();
    const confirmed = held<RelayEvent[]>();
    f.relayFeed.state.channel = () => confirmed.promise;
    f.revoke();
    expect(f.store.instructions(instructions)).toMatchObject({ ok: false });
    // A live revision meanwhile doesn't give it back either.
    f.relayFeed.emit(await revision("B", f.a.id));
    await flush();
    expect(f.store.instructions(instructions)).toMatchObject({ ok: false });
    confirmed.release([metadata(), members()]);
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "A",
      }),
    );
    expect(f.spies.problem).not.toHaveBeenCalled();
  });

  it("an older confirm never undoes a newer one's authority", async () => {
    const f = await following();
    const removal = held<RelayEvent[]>();
    f.relayFeed.state.channel = () => removal.promise;
    f.hear(members([]));
    await flush();
    // The owner is back, and a confirm since says so first.
    f.relayFeed.state.channel = () => [metadata(), members()];
    f.hear(members());
    await flush();
    removal.release([metadata(), members([])]);
    await flush();
    await flush();
    expect(f.store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("follows no channel while a sync is open", async () => {
    const { relayFeed } = await synced();
    expect(relayFeed.follows.size).toBe(0);
  });

  it("an older confirm takes a newer one's failure too", async () => {
    const f = await following();
    const older = held<RelayEvent[]>();
    f.relayFeed.state.channel = () => older.promise;
    f.revoke();
    await flush();
    f.relayFeed.state.channel = () => {
      throw new Error("Relay unreachable");
    };
    f.hear(members());
    await vi.waitFor(() =>
      expect(f.spies.problem).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stale" }),
      ),
    );
    older.release([metadata(), members()]);
    await vi.waitFor(() =>
      expect(f.spies.problem).toHaveBeenCalledWith({
        channel,
        kind: "denied",
      }),
    );
    expect(f.store.instructions(instructions)).toMatchObject({ ok: false });
  });

  it("a revision heard during a recovery's read is caught up after it", async () => {
    let b: RelayEvent | undefined;
    const recovery = held<RelayEvent[]>();
    let currents = 0;
    const f = await following((filter, a) => {
      if (filter.artifact !== "current") return b ? [b] : [a];
      return ++currents === 2 ? recovery.promise : [a];
    });
    f.revoke();
    await vi.waitFor(() => expect(currents).toBe(2));
    b = await revision("B", f.a.id);
    f.relayFeed.emit(b);
    recovery.release([f.a]);
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "B",
      }),
    );
  });

  it("catches up a revision even while a reread from before the revocation is out", async () => {
    let b: RelayEvent | undefined;
    let lookups = 0;
    let holdLookup = false;
    const old = held<RelayEvent[]>();
    const recovery = held<RelayEvent[]>();
    let currents = 0;
    const f = await following((filter, a) => {
      if (filter.artifact === "current")
        return ++currents === 2 ? recovery.promise : [a];
      lookups++;
      if (holdLookup) {
        holdLookup = false;
        return old.promise;
      }
      return b ? [b] : [a];
    });
    // A revision past one this device missed: its reread is still out.
    holdLookup = true;
    const before = lookups;
    f.relayFeed.emit(await revision("D", (await revision("X", f.a.id)).id));
    await vi.waitFor(() => expect(lookups).toBe(before + 1));
    try {
      f.revoke();
      await vi.waitFor(() => expect(currents).toBe(2));
      b = await revision("B", f.a.id);
      f.relayFeed.emit(b);
      recovery.release([f.a]);
      await vi.waitFor(() =>
        expect(f.store.instructions(instructions)).toEqual({
          ok: true,
          text: "B",
        }),
      );
    } finally {
      old.release([f.a]);
    }
  });

  it("a recovery from before a reconnect never denies what the reconnect read", async () => {
    const recovery = held<RelayEvent[]>();
    let currents = 0;
    const f = await following((filter, a) =>
      filter.artifact === "current" && ++currents === 2
        ? recovery.promise
        : [a],
    );
    f.revoke();
    await vi.waitFor(() => expect(currents).toBe(2));
    f.relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "A",
      }),
    );
    recovery.fail(new Error("Relay read failed (403)"));
    await flush();
    await flush();
    expect(f.store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    expect(f.spies.problem).not.toHaveBeenCalled();
  });

  it("a fallback read from before a reconnect never denies what the reconnect read", async () => {
    const old = held<RelayEvent[]>();
    let b: RelayEvent | undefined;
    let currents = 0;
    const f = await following((filter, a) => {
      if (filter.artifact !== "current") return b ? [b] : [a];
      return ++currents === 2 ? old.promise : b ? [b] : [a];
    });
    f.relayFeed.reconnect();
    await vi.waitFor(() => expect(currents).toBe(2));
    b = await revision("B", f.a.id);
    f.relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "B",
      }),
    );
    old.fail(new Error("Relay read failed (403)"));
    await flush();
    await flush();
    expect(f.store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(f.spies.problem).not.toHaveBeenCalled();
  });

  it("a reread from before a reconnect never denies what the reconnect read", async () => {
    const old = held<RelayEvent[]>();
    let b: RelayEvent | undefined;
    let holding = false;
    const f = await following((filter, a) => {
      if (filter.artifact === "current" || !holding) return b ? [b] : [a];
      holding = false;
      return old.promise;
    });
    // A revision past one this device missed: its reread is still out.
    holding = true;
    f.relayFeed.emit(await revision("D", (await revision("X", f.a.id)).id));
    await vi.waitFor(() => expect(holding).toBe(false));
    b = await revision("B", f.a.id);
    f.relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "B",
      }),
    );
    old.fail(new Error("Relay read failed (403)"));
    await flush();
    await flush();
    expect(f.store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(f.spies.problem).not.toHaveBeenCalled();
  });

  it("a reread queued behind one from before a reconnect still runs when that one fails", async () => {
    const old = held<RelayEvent[]>();
    let b: RelayEvent | undefined;
    let e: RelayEvent | undefined;
    let holding = false;
    const f = await following((filter, a) => {
      if (filter.artifact === "current") return b ? [b] : [a];
      if (!holding) return [e ?? b ?? a];
      holding = false;
      return old.promise;
    });
    holding = true;
    f.relayFeed.emit(await revision("D", (await revision("X", f.a.id)).id));
    await vi.waitFor(() => expect(holding).toBe(false));
    try {
      b = await revision("B", f.a.id);
      f.relayFeed.reconnect();
      await vi.waitFor(() =>
        expect(f.store.instructions(instructions)).toEqual({
          ok: true,
          text: "B",
        }),
      );
      // Past another missed revision: queued behind the old reread.
      e = await revision("E", (await revision("Y", b.id)).id);
      f.relayFeed.emit(e);
    } finally {
      old.fail(new Error("Relay read failed (403)"));
    }
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toEqual({
        ok: true,
        text: "E",
      }),
    );
    expect(f.spies.problem).not.toHaveBeenCalled();
  });

  it("a read held across a connection never replaces the deletion read after it", async () => {
    const a = await revision("A");
    const d = await artifactD("buzz.agent.instructions", channel);
    const deletion = signed(owner, {
      kind: 45010,
      content: "",
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", "buzz.agent.instructions"],
        ["op", "delete"],
        ["prev", a.id],
      ],
    });
    const old = held<RelayEvent[]>();
    let currents = 0;
    const relayFeed = controlled((filter) => {
      if (filter.artifact === "current")
        return ++currents === 1 ? old.promise : [];
      return filter["#d"]?.[0] === d ? [deletion] : [];
    });
    relayFeed.state.capacity = false;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(currents).toBe(1));
    relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(store.state(instructions).state).toBe("deleted"),
    );
    old.release([a]);
    await bound;
    await flush();
    expect(store.state(instructions).state).toBe("deleted");
  });

  it("a fallback for a new binding reads only that binding", async () => {
    const a = await revision("A");
    const relayFeed = controlled(() => [a]);
    relayFeed.state.capacity = false;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    await sync.bind([binding]);
    const before = relayFeed.reads.length;
    const other = "5f0c3a5e-1a1b-4c2d-9e8f-001122334455";
    await sync.bind([
      { ...binding, subject: keypair().pubkey, channel: other },
    ]);
    const after = relayFeed.reads.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const filter of after) {
      expect(filter["#d"] ?? []).not.toContain(channel);
      expect(filter["#h"] ?? []).not.toContain(channel);
    }
  });

  it("no sync capacity falls back to finite reads", async () => {
    const a = await revision("A");
    const relayFeed = controlled(() => [a]);
    relayFeed.state.capacity = false;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    await sync.bind([binding]);
    expect(relayFeed.views).toHaveLength(0);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("a transport failure keeps the seeded head, reports stale and retries a bounded number of times", async () => {
    vi.useFakeTimers();
    try {
      const { store, relayFeed, problem, failWith } = await synced();
      relayFeed.set("unsupported");
      failWith(new Error("Relay response was interrupted"));
      const reads = relayFeed.artifactReads().length;
      relayFeed.reconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relayFeed.artifactReads().length - reads).toBe(4 * 2);
      expect(problem).toHaveBeenCalledWith({
        channel,
        kind: "stale",
        error: "Relay response was interrupted",
      });
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config sync binding lifetime", () => {
  async function bindHeld() {
    const a = await revision("A");
    const confirm = held<RelayEvent[]>();
    const relayFeed = controlled(() => []);
    relayFeed.state.channel = () => confirm.promise;
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    const view = relayFeed.view();
    return { confirm, relayFeed, store, sync, bound, view };
  }

  it("a set held across unbind never installs, and its sync closes", async () => {
    const { confirm, store, sync, bound, view } = await bindHeld();
    sync.unbind(channel);
    confirm.release([metadata(), members()]);
    await bound;
    expect(store.state(instructions).state).toBe("unavailable");
    expect(view?.open).toBe(false);
  });

  it("a set held across dispose never installs", async () => {
    const { confirm, store, sync, bound, view } = await bindHeld();
    sync.dispose();
    confirm.release([metadata(), members()]);
    await bound;
    expect(store.state(instructions).state).toBe("unavailable");
    expect(view?.open).toBe(false);
  });

  it("a reread started before unbind cannot install after it", async () => {
    const a = await revision("A");
    let next: RelayEvent[] | Promise<RelayEvent[]> = [a];
    const relayFeed = controlled(() => next);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    await bound;
    const reread = held<RelayEvent[]>();
    next = reread.promise;
    const reads = relayFeed.artifactReads().length;
    relayFeed.set("live", [await revision("C", "f".repeat(64))]);
    await vi.waitFor(() =>
      expect(relayFeed.artifactReads().length).toBeGreaterThan(reads),
    );
    sync.unbind(channel);
    reread.release([await revision("B", a.id)]);
    await flush();
    expect(store.state(instructions).state).toBe("unavailable");
    next = [a];
    const again = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.view()).toBeDefined());
    relayFeed.set("live", [a]);
    await again;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });
});

describe("config sync rediscovery", () => {
  it("strongly rediscovers config channels created while disconnected", async () => {
    const { relayFeed, discovery } = await synced();
    const created = signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", "5f0c3a5e-1a1b-4c2d-9e8f-001122334455"]],
    });
    relayFeed.state.discovery = () => [created];
    relayFeed.reconnect();
    await vi.waitFor(() => expect(discovery).toHaveBeenCalledWith(created));
    // Only labeled config channels, not every channel the owner created.
    expect(relayFeed.reads).toContainEqual(
      expect.objectContaining({
        "#P": [owner.pubkey],
        "#t": ["agent-config", "team-config"],
      }),
    );
  });

  // The fake feed skips verification, so unsigned shapes keep these fast.
  const channelsAt = (createdAt: (i: number) => number) =>
    Array.from(
      { length: DISCOVERY_PAGE + 1 },
      (_, i) =>
        ({
          id: String(i).padStart(64, "0"),
          pubkey: relay.pubkey,
          kind: 39000,
          content: "",
          created_at: createdAt(i),
          tags: [
            ["d", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`],
          ],
          sig: "",
        }) as unknown as RelayEvent,
    ).reverse();

  it("rediscovery past one created_at page is partial and keeps bindings", async () => {
    const { relayFeed, discovery, problem, store } = await synced();
    const channels = channelsAt(() => 1_000_000);
    const pages: ReadFilter[] = [];
    relayFeed.state.discovery = (filter) => {
      pages.push(filter);
      return channels.slice(0, DISCOVERY_PAGE);
    };
    discovery.mockClear();
    relayFeed.reconnect();
    // The second page held nothing new: it stops there.
    await vi.waitFor(() => expect(pages).toHaveLength(2));
    await flush();
    expect(pages.map((f) => f.until)).toEqual([undefined, 1_000_000]);
    expect(discovery).toHaveBeenCalledTimes(DISCOVERY_PAGE);
    expect(problem).not.toHaveBeenCalled();
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("rediscovery pages back by until past the relay's page clamp", async () => {
    const { relayFeed, discovery, store } = await synced();
    const channels = channelsAt((i) => 1_000_000 + i);
    const pages: ReadFilter[] = [];
    relayFeed.state.discovery = (filter) => {
      pages.push(filter);
      expect(filter.limit).toBe(DISCOVERY_PAGE);
      return channels
        .filter(
          (e) => filter.until === undefined || e.created_at <= filter.until,
        )
        .slice(0, DISCOVERY_PAGE);
    };
    discovery.mockClear();
    relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(discovery).toHaveBeenCalledTimes(DISCOVERY_PAGE + 1),
    );
    // The short second page ends it.
    await flush();
    expect(pages.map((f) => f.until)).toEqual([undefined, 1_000_001]);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });
});
