// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { assert, expect, it, vi } from "vitest";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
} from "../relay/contracts";
import { ReadError } from "../relay/errors";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../relay/testing";
import { SEEK_PAGES, useMessageOpening } from "./use-message-opening";

/** A channel whose history is `pages` pages of top-level rows, oldest first;
 * the head is the last page. Older pages arrive when `deliver` is called. */
function channel(pages: string[][], replies: Record<string, string> = {}) {
  const row = (id: string) =>
    ({ id, threadRootId: replies[id] }) as unknown as ChannelMessage;
  let loaded = 1;
  let window: ChannelWindow = {
    channelId: "c",
    status: "loading",
    rows: [],
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const set = (next: Partial<ChannelWindow>) => {
    window = { ...window, ...next };
    for (const listener of listeners) listener();
  };
  const rows = () => pages.slice(-loaded).flat().map(row);
  const loadOlder = vi.fn(() => {
    if (window.loadingOlder) return;
    set({ loadingOlder: true });
  });
  const queries = {
    window: () => window,
    subscribeWindow: (_: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: vi.fn(),
    loadOlder,
  } as unknown as ChannelQueries;
  return {
    queries,
    loadOlder,
    /** A cached window: readable rows, not yet verified against the relay. */
    cached(ids: string[], error?: string) {
      act(() =>
        set({
          status: "ready",
          freshness: "cached",
          rows: ids.map(row),
          hasMore: true,
          error,
        }),
      );
    },
    head() {
      act(() =>
        set({
          status: "ready",
          freshness: "verified",
          rows: rows(),
          hasMore: pages.length > 1,
        }),
      );
    },
    deliver() {
      act(() => {
        loaded += 1;
        set({
          loadingOlder: false,
          rows: rows(),
          hasMore: loaded < pages.length,
        });
      });
    },
  };
}

it("opens a top-level message in the head without reading older pages", () => {
  const c = channel([["old"], ["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  expect(view.result.current).toBeUndefined();
  c.head();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).not.toHaveBeenCalled();
});

it("reads older pages until the message loads, then opens it in the timeline", () => {
  const c = channel([["target"], ["b"], ["c"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.head();
  expect(view.result.current).toBeUndefined();
  c.deliver();
  expect(view.result.current).toBeUndefined();
  c.deliver();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).toHaveBeenCalledTimes(2);
});

it("opens a reply, or a message not in the history, as its thread", () => {
  const reply = channel([["root", "reply"]], { reply: "root" });
  const replyView = renderHook(() =>
    useMessageOpening(reply.queries, "c", "reply"),
  );
  reply.head();
  expect(replyView.result.current).toBe(false);
  const missing = channel([["a"], ["b"]]);
  const missingView = renderHook(() =>
    useMessageOpening(missing.queries, "c", "gone"),
  );
  missing.head();
  missing.deliver();
  expect(missingView.result.current).toBe(false);
  expect(missing.loadOlder).toHaveBeenCalledOnce();
});

it(`stops after ${SEEK_PAGES} older pages and opens the thread`, () => {
  const c = channel([
    ["target"],
    // One page beyond the last one it reads.
    ...Array.from({ length: SEEK_PAGES + 1 }, (_, i) => [`m${i}`]),
  ]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.head();
  for (let page = 0; page < SEEK_PAGES; page += 1) c.deliver();
  expect(view.result.current).toBe(false);
  expect(c.loadOlder).toHaveBeenCalledTimes(SEEK_PAGES);
});

it("waits through a cached window and opens what verified history shows", () => {
  const c = channel([["old"], ["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  // The cached head predates the target: not yet evidence that it is missing.
  c.cached(["old"]);
  expect(view.result.current).toBeUndefined();
  expect(c.loadOlder).not.toHaveBeenCalled();
  c.head();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).not.toHaveBeenCalled();
});

it("a failed revalidation of a cached window opens the thread", () => {
  const c = channel([["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.cached(["new"], "offline");
  expect(view.result.current).toBe(false);
});

it("reads no window without a message", () => {
  const c = channel([["a"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", undefined));
  expect(view.result.current).toBeUndefined();
  expect(c.queries.ensure).not.toHaveBeenCalled();
});

/** A real relay session with one channel, "a", whose head the test scripts.
 * `head(...)` is a first page whose oldest row has more history before it. */
async function relayChannel() {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const time = { now: 1_000_000 };
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(scripted.transport, {
    prepared: true,
    now: () => time.now,
  });
  store.session.channels.ensureList();
  scripted
    .next()
    .respond([roster(relay, "a", [viewer.pubkey]), metadata(relay, "a", "a")]);
  await flush();
  return {
    store,
    channels: store.session.channels,
    pending: scripted.pending,
    time,
    post: (content: string, at: number) => message(alice, "a", content, at),
    head: (...rows: ReturnType<typeof message>[]) => {
      const last = rows[rows.length - 1];
      return [
        ...rows,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: last
            ? { created_at: last.created_at, id: last.id }
            : null,
        }),
      ];
    },
    end: (
      before: ReturnType<typeof message>,
      ...rows: ReturnType<typeof message>[]
    ) => [
      ...rows,
      bounds(relay, "a", `${before.created_at}:${before.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ],
    /** The next channel read; profile reads get nothing. */
    read() {
      for (;;) {
        const entry = scripted.next();
        if (entry.filters[0]?.["#h"]) return entry;
        entry.respond([]);
      }
    },
  };
}

it("waits for a head refresh before reading older pages for the message", async () => {
  const c = await relayChannel();
  try {
    const target = c.post("target", 10);
    const newer = c.post("newer", 20);
    c.channels.ensure("a");
    c.read().respond(c.head(newer));
    await flush();
    expect(c.channels.window("a")).toMatchObject({
      status: "ready",
      freshness: "verified",
    });
    // Past the head's freshness lease, opening the channel refreshes its head.
    c.time.now += 61_000;
    const view = renderHook(() =>
      useMessageOpening(c.channels, "a", target.id),
    );
    const refresh = c.read();
    expect(c.pending).toHaveLength(0);
    // A busy head is not missing history: no decision yet.
    expect(view.result.current).toBeUndefined();
    await act(async () => {
      refresh.respond(c.head(newer));
      await flush();
    });
    expect(view.result.current).toBeUndefined();
    const older = c.read();
    expect(older.filters[0]?.until).toBe(20);
    await act(async () => {
      older.respond(c.end(newer, target));
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    c.store.dispose();
  }
});

it("decides on the refreshed head, not the expired one that held the message", async () => {
  const c = await relayChannel();
  try {
    const target = c.post("target", 10);
    const newer = c.post("newer", 20);
    c.channels.ensure("a");
    c.read().respond(c.head(target));
    await flush();
    expect(c.channels.window("a").rows.map((row) => row.id)).toEqual([
      target.id,
    ]);
    c.time.now += 61_000;
    const view = renderHook(() =>
      useMessageOpening(c.channels, "a", target.id),
    );
    // The expired head still shows the message, but it may be stale.
    expect(view.result.current).toBeUndefined();
    const refresh = c.read();
    // A newer post pushed the message out of the head.
    await act(async () => {
      refresh.respond(c.head(newer));
      await flush();
    });
    expect(c.channels.window("a").rows.map((row) => row.id)).toEqual([
      newer.id,
    ]);
    expect(view.result.current).toBeUndefined();
    const older = c.read();
    await act(async () => {
      older.respond(c.end(newer, target));
      await flush();
    });
    expect(view.result.current).toBe(true);
    expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
      target.id,
    );
  } finally {
    c.store.dispose();
  }
});

it("waits for a queued catch-up retry instead of deciding on its earlier failure", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  /** The next channel head read; profile reads get nothing. */
  const read = () => {
    for (;;) {
      const entry = wire.next();
      if (entry.filters[0]?.["#h"]) return entry;
      entry.respond([]);
    }
  };
  try {
    const channels = owner.session.channels;
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    const older = message(alice, "a", "older", 10);
    const page = (...rows: ReturnType<typeof message>[]) => [
      ...rows,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: older.id },
      }),
    ];
    channels.ensure("a");
    read().respond(page(older));
    await flush();
    // The stream reconnects and its catch-up read fails.
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    read().fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    expect(channels.window("a")).toMatchObject({
      status: "ready",
      freshness: "cached",
      error: expect.any(String),
    });
    // The target arrived while the stream was down.
    const target = message(alice, "a", "target", 20);
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    // Opening demands the channel, which queues a retry: not yet a failure.
    expect(view.result.current).toBeUndefined();
    const retry = read();
    await act(async () => {
      retry.respond(page(target, older));
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("waits for a queued retry of an empty failed channel while catch-up slots are busy", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  /** The pending head read for one channel; profile reads get nothing. */
  const take = (id: string) => {
    for (const entry of [...wire.pending])
      if (!entry.filters[0]?.["#h"]) {
        wire.pending.splice(wire.pending.indexOf(entry), 1);
        entry.respond([]);
      }
    const index = wire.pending.findIndex((entry) =>
      entry.filters[0]?.["#h"]?.includes(id),
    );
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert(entry, `no pending read for ${id}`);
    return entry;
  };
  const empty = (id: string) => [
    bounds(relay, id, "head", { has_more: false, next_cursor: null }),
  ];
  try {
    const channels = owner.session.channels;
    live.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [viewer.pubkey])),
    );
    for (const id of ["b", "c"]) {
      channels.ensure(id);
      take(id).respond(empty(id));
      await flush();
    }
    // "a" never loaded: its first read failed, and so did its catch-up.
    channels.ensure("a");
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    expect(channels.window("a")).toMatchObject({ status: "error", rows: [] });
    // Hold both catch-up slots with other channels' reads.
    live.established("c");
    live.established("b");
    await flush();
    const first = take("c");
    channels.ensure("b");
    await flush();
    const second = take("b");
    const target = message(alice, "a", "target", 20);
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    // The retry is queued behind the busy slots: not yet a failure.
    expect(wire.pending.filter((entry) => entry.filters[0]?.["#h"])).toEqual(
      [],
    );
    expect(view.result.current).toBeUndefined();
    await act(async () => {
      first.respond(empty("c"));
      second.respond(empty("b"));
      await flush();
    });
    expect(view.result.current).toBeUndefined();
    const retry = take("a");
    await act(async () => {
      retry.respond([target, ...empty("a")]);
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("reads an empty channel again when the stream drops before its queued retry runs", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const heads = () => wire.pending.filter((entry) => entry.filters[0]?.["#h"]);
  /** The pending head read for one channel; profile reads get nothing. */
  const take = (id: string) => {
    for (const entry of [...wire.pending])
      if (!entry.filters[0]?.["#h"]) {
        wire.pending.splice(wire.pending.indexOf(entry), 1);
        entry.respond([]);
      }
    const index = wire.pending.findIndex((entry) =>
      entry.filters[0]?.["#h"]?.includes(id),
    );
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert(entry, `no pending read for ${id}`);
    return entry;
  };
  const empty = (id: string) => [
    bounds(relay, id, "head", { has_more: false, next_cursor: null }),
  ];
  try {
    const channels = owner.session.channels;
    live.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [viewer.pubkey])),
    );
    for (const id of ["b", "c"]) {
      channels.ensure(id);
      take(id).respond(empty(id));
      await flush();
    }
    // "a" never loaded: its first read failed, and so did its catch-up.
    channels.ensure("a");
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    // Hold both catch-up slots, so the retry for "a" stays queued.
    live.established("c");
    live.established("b");
    await flush();
    take("c");
    channels.ensure("b");
    await flush();
    take("b");
    const target = message(alice, "a", "target", 20);
    const first = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    expect(heads()).toEqual([]);
    expect(channels.window("a").status).toBe("loading");
    // The stream drops before the queued retry is dispatched.
    await act(async () => {
      live.state({ status: "connecting", routes: [] });
      await flush();
    });
    expect(channels.window("a").status).not.toBe("loading");
    first.unmount();
    // Reopening reads the channel over HTTP instead of waiting for the stream.
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    expect(view.result.current).toBeUndefined();
    const read = take("a");
    await act(async () => {
      read.respond([target, ...empty("a")]);
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});
