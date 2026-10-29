// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useChannelReference } from "../conversation/channel-reference";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { keypair, metadata, roster, scriptedTransport } from "./testing";

const relay = keypair(),
  viewer = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
/** Settles store callbacks, with or without fake timers. */
const flush = () =>
  vi.isFakeTimers()
    ? act(() => vi.advanceTimersByTimeAsync(0))
    : new Promise((resolve) => setTimeout(resolve, 0));
const MINE = "20000000-0000-4000-8000-000000000001";
const OPEN = "20000000-0000-4000-8000-000000000002";
const SECRET = "20000000-0000-4000-8000-000000000003";
const open = (id: string, name: string, extra: string[][] = []) =>
  metadata(relay, id, name, 1_700_000_000, [
    ["public"],
    ["t", "stream"],
    ["about", `About ${name}`],
    ...extra,
  ]);

// With the joined channel, their previews fill discovery's 1,024 metadata
// slots. Signed once: signing takes most of the test that uses them.
const previews = new Map<string, RelayEvent>();
beforeAll(() => {
  for (let n = 0; n < 1023; n++) {
    const id = `21000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    previews.set(id, open(id, `preview-${n}`));
  }
});
/** One mounted channel link. */
function Link({ channels, id }: { channels: ChannelQueries; id: string }) {
  useChannelReference(channels, id);
  return null;
}
const links = (channels: ChannelQueries, ids: readonly string[]) =>
  createElement(
    Fragment,
    null,
    ids.map((id) => createElement(Link, { key: id, channels, id })),
  );

/** A real session whose list is ready with one joined public channel. */
async function setup() {
  let clock = 1_000_000;
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let receive!: (events: readonly RelayEvent[]) => void;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { now: () => clock },
  );
  owners.push(owner);
  const channels = owner.session.channels;
  const next = async (kind: number) => {
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    const request = wire.next();
    expect(request.filters[0]?.kinds).toEqual([kind]);
    return request;
  };
  channels.ensureList();
  (await next(39002)).respond([roster(relay, MINE, [viewer.pubkey])]);
  (await next(39000)).respond([open(MINE, "mine")]);
  await vi.waitFor(() => expect(channels.list().status).toBe("ready"));
  await vi.waitFor(() =>
    expect(owner.session.live.snapshot().roster.state).toBe("verified"),
  );
  wire.pending.splice(0);
  return {
    ...wire,
    channels,
    owner,
    next,
    emit: (events: readonly RelayEvent[]) => receive(events),
    tick: (ms: number) => {
      clock += ms;
    },
    /** One coalesced exact lookup, answered with `events`. */
    async lookup(ids: string[], events: RelayEvent[] | Error) {
      const request = await next(39000);
      expect(request.filters.map((filter) => filter["#d"])).toEqual([ids, ids]);
      if (events instanceof Error) request.fail(events);
      else request.respond(events);
      await vi.waitFor(() => expect(wire.pending).toHaveLength(0));
      await flush();
    },
    /** Moves the store clock and its timers together. */
    async advance(ms: number) {
      clock += ms;
      await act(() => vi.advanceTimersByTimeAsync(ms));
    },
  };
}

it("describes a joined channel locally and never reads for it", async () => {
  const h = await setup();
  h.channels.refer?.(MINE);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
  expect(h.channels.describe?.(MINE)).toMatchObject({
    state: "found",
    name: "mine",
    joined: true,
    members: 1,
  });
});

it("coalesces lookups, describes an open channel and withholds a private one", async () => {
  const h = await setup();
  const notified = vi.fn();
  h.channels.subscribeList(notified);
  h.channels.refer?.(OPEN);
  h.channels.refer?.(SECRET);
  h.channels.refer?.(OPEN);
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "unknown" });
  await h.lookup([OPEN, SECRET], [open(OPEN, "crew")]);
  expect(h.channels.describe?.(OPEN)).toEqual({
    state: "found",
    name: "crew",
    description: "About crew",
    channelType: "stream",
    private: false,
    hidden: false,
    archived: false,
    joined: false,
  });
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "withheld" });
  expect(notified).toHaveBeenCalled();
});

it("keeps a withheld answer for five minutes, then rechecks it while still showing it", async () => {
  const h = await setup();
  h.channels.refer?.(SECRET);
  await h.lookup([SECRET], []);
  h.tick(5 * 60_000 - 1);
  h.channels.refer?.(SECRET);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
  h.tick(1);
  h.channels.refer?.(SECRET);
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "withheld" });
  // The channel has since become public.
  await h.lookup([SECRET], [open(SECRET, "launch")]);
  expect(h.channels.describe?.(SECRET)).toMatchObject({
    state: "found",
    name: "launch",
  });
});

it("never reports a failed lookup as withheld, and backs off before retrying", async () => {
  const h = await setup();
  h.channels.refer?.(SECRET);
  await h.lookup([SECRET], new Error("503"));
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "unknown" });
  h.tick(29_999);
  h.channels.refer?.(SECRET);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
  h.tick(1);
  h.channels.refer?.(SECRET);
  await h.lookup([SECRET], []);
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "withheld" });
});

it("describes a public channel the viewer left as public and not joined", async () => {
  const h = await setup();
  h.emit([roster(relay, MINE, [], 1_700_000_001)]);
  await vi.waitFor(() => expect(h.channels.get?.(MINE)).toBeUndefined());
  expect(h.channels.describe?.(MINE)).toMatchObject({
    state: "found",
    name: "mine",
    private: false,
    joined: false,
  });
  h.channels.refer?.(MINE);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
});

it("forgets withheld answers when the session cache is cleared", async () => {
  const h = await setup();
  h.channels.refer?.(SECRET);
  await h.lookup([SECRET], []);
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "withheld" });
  await h.owner.clearCache();
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "unknown" });
});

it("describes a joined channel restored from cache as joined", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    },
    {
      prepared: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: [roster(relay, MINE, [viewer.pubkey]), open(MINE, "mine")],
          },
        }),
        writeStartup: async () => {},
        read: async () => [],
        write: async () => {},
        retain: async () => {},
        remove: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  owners.push(owner);
  await owner.restore();
  const channels = owner.session.channels;
  channels.ensureList();
  // The relay hasn't reconfirmed it yet: the store marks it read-only.
  await vi.waitFor(() => expect(channels.get?.(MINE)?.cached).toBe(true));
  expect(channels.get?.(MINE)?.readOnly).toBe(true);
  expect(channels.describe?.(MINE)).toMatchObject({
    state: "found",
    joined: true,
    members: 1,
  });
});

it("retries a mounted link after its failure backoff, then stops once unmounted", async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await h.lookup([SECRET], new Error("503"));
  expect(link.result.current).toEqual({ state: "unknown" });
  await h.advance(29_999);
  expect(h.pending).toHaveLength(0);
  // Nothing re-renders the link: the store's own wake-up retries it.
  await h.advance(1);
  await h.lookup([SECRET], []);
  expect(link.result.current).toEqual({ state: "withheld" });
  link.unmount();
  await h.advance(5 * 60_000);
  await flush();
  expect(h.pending).toHaveLength(0);
});

it("rechecks a mounted withheld link after five minutes", async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await h.lookup([SECRET], []);
  expect(link.result.current).toEqual({ state: "withheld" });
  await h.advance(5 * 60_000 - 1);
  expect(h.pending).toHaveLength(0);
  await h.advance(1);
  // The answer stays on screen while it is rechecked.
  expect(link.result.current).toEqual({ state: "withheld" });
  // The channel has since become public.
  await h.lookup([SECRET], [open(SECRET, "launch")]);
  expect(link.result.current).toMatchObject({ state: "found", name: "launch" });
});

it("arms the recheck for a link remounted during its backoff", async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = renderHook(() => useChannelReference(h.channels, SECRET));
  await flush();
  const request = await h.next(39000);
  // The last link leaves while its lookup is in flight; the read then fails.
  first.unmount();
  request.fail(new Error("503"));
  await vi.waitFor(() => expect(h.pending).toHaveLength(0));
  await flush();
  await h.advance(10_000);
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await flush();
  expect(h.pending).toHaveLength(0);
  await h.advance(19_999);
  expect(h.pending).toHaveLength(0);
  await h.advance(1);
  await h.lookup([SECRET], []);
  expect(link.result.current).toEqual({ state: "withheld" });
});

it("tells a mounted withheld link about a cache reset and looks it up again", async () => {
  const h = await setup();
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await h.lookup([SECRET], []);
  expect(link.result.current).toEqual({ state: "withheld" });
  await act(() => h.owner.clearCache());
  expect(link.result.current).toEqual({ state: "unknown" });
  // The channel has since become public.
  await h.lookup([SECRET], [open(SECRET, "launch")]);
  expect(link.result.current).toMatchObject({ state: "found", name: "launch" });
});

it("looks a mounted link up again when a reset drops its in-flight reply", async () => {
  const h = await setup();
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await flush();
  const stale = await h.next(39000);
  await act(() => h.owner.clearCache());
  stale.respond([]);
  await flush();
  await h.lookup([SECRET], [open(SECRET, "launch")]);
  expect(link.result.current).toMatchObject({ state: "found", name: "launch" });
});

it("looks a mounted link up again when the viewer leaves its private channel", async () => {
  const h = await setup();
  h.emit([
    roster(relay, SECRET, [viewer.pubkey]),
    metadata(relay, SECRET, "inner", 1_700_000_000, [["private"]]),
  ]);
  const link = renderHook(() => useChannelReference(h.channels, SECRET));
  await vi.waitFor(() =>
    expect(link.result.current).toMatchObject({ state: "found", joined: true }),
  );
  await flush();
  expect(h.pending).toHaveLength(0);
  await act(async () => {
    h.emit([roster(relay, SECRET, [], 1_700_000_001)]);
  });
  await h.lookup([SECRET], []);
  expect(link.result.current).toEqual({ state: "withheld" });
});

it("looks a mounted link up again when a public channel the viewer left turns private", async () => {
  const h = await setup();
  const link = renderHook(() => useChannelReference(h.channels, MINE));
  await act(async () => {
    h.emit([roster(relay, MINE, [], 1_700_000_001)]);
  });
  await flush();
  expect(link.result.current).toMatchObject({ state: "found", joined: false });
  expect(h.pending).toHaveLength(0);
  // Access was already lost, so this revokes nothing and resets no answer.
  await act(async () => {
    h.emit([metadata(relay, MINE, "mine", 1_700_000_002, [["private"]])]);
  });
  await h.lookup([MINE], []);
  expect(link.result.current).toEqual({ state: "withheld" });
});

it("keeps a cancelled lookup from the old cache out of the new one's backoff", async () => {
  const h = await setup();
  const release = h.channels.refer?.(SECRET);
  await flush();
  const stale = await h.next(39000);
  release?.();
  const cleared = h.owner.clearCache();
  // The new cache's answers are read before the old read's cancellation
  // settles.
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "unknown" });
  await cleared;
  stale.fail(new Error("aborted"));
  await flush();
  h.channels.refer?.(SECRET);
  await h.lookup([SECRET], []);
  expect(h.channels.describe?.(SECRET)).toEqual({ state: "withheld" });
});

it("keeps mounted links' previews when a joined channel needs a slot, and reads none of them again", async () => {
  const h = await setup();
  const ids = [...previews.keys()];
  const view = render(links(h.channels, ids));
  for (let n = 0; n < ids.length; n += 128) {
    const request = await h.next(39000);
    request.respond(
      (request.filters[0]?.["#d"] ?? []).flatMap(
        (id) => previews.get(id) ?? [],
      ),
    );
  }
  await vi.waitFor(() =>
    expect(
      ids.filter((id) => h.channels.describe?.(id).state !== "found"),
    ).toEqual([]),
  );
  const LAUNCH = "30000000-0000-4000-8000-000000000000";
  const row = () =>
    h.channels.list().channels.find((channel) => channel.id === LAUNCH);
  /** A list pass that finds the viewer has joined LAUNCH. */
  const refresh = async () => {
    h.channels.refreshList?.();
    (await h.next(39002)).respond([
      roster(relay, MINE, [viewer.pubkey]),
      roster(relay, LAUNCH, [viewer.pubkey]),
    ]);
    const request = await h.next(39000);
    await act(async () => {
      request.respond([open(MINE, "mine"), open(LAUNCH, "launch")]);
      await flush();
    });
    await flush();
  };

  await refresh();
  // A link whose preview gave way would look its channel up again, taking
  // the slot of the next one, without end.
  expect(h.pending).toHaveLength(0);
  expect(row()?.metadataPending).toBe(true);
  expect(h.channels.list().coverage).toBe("partial");
  expect(h.channels.describe?.(ids[0] ?? "")).toMatchObject({ state: "found" });

  // Unmounting a link frees its slot for the next pass.
  view.rerender(links(h.channels, ids.slice(1)));
  await refresh();
  expect(row()).toMatchObject({ name: "launch" });
  expect(row()?.metadataPending).toBeUndefined();
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.describe?.(ids[0] ?? "")).toEqual({ state: "unknown" });
  expect(h.channels.describe?.(ids[1] ?? "")).toMatchObject({ state: "found" });
  expect(h.pending).toHaveLength(0);
});
