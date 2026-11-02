// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../relay/events";
import { createRelaySession } from "../relay/session";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import { useIncomingHuddle } from "./use-incoming";

const parent = "00000000-0000-4000-8000-000000000001";
const room = "00000000-0000-4000-8000-000000000002";
const authority = "ab".repeat(32),
  creator = "cd".repeat(32);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("observes a private conversation's remote call, honors signed ends, expires, and retires on navigation", () => {
  vi.useFakeTimers();
  const store = createRelaySession(null);
  const listeners = new Set<() => void>();
  const dispose = vi.fn();
  let events: EventData[] = [];
  const session = {
    ...store.session,
    relayAuthor: authority,
    observe: vi.fn(() => ({
      snapshot: () => ({ status: "ready" as const, events }),
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      refresh: async () => {},
      dispose,
    })),
  };
  const { result, rerender, unmount } = renderHook(
    ({ channel }) => useIncomingHuddle(session, channel),
    { initialProps: { channel: parent } },
  );
  expect(result.current).toBeUndefined();
  const start = {
    id: "start",
    pubkey: creator,
    created_at: Math.floor(Date.now() / 1000),
    kind: 48100,
    tags: [["h", parent]],
    content: JSON.stringify({ ephemeral_channel_id: room }),
  };
  const publish = (next: EventData[]) =>
    act(() => {
      events = next;
      for (const fn of listeners) fn();
    });
  const join = {
    ...start,
    id: "join",
    kind: 48101,
    pubkey: authority,
    tags: [...start.tags, ["p", creator]],
  };
  publish([start, join]);
  expect(result.current).toEqual({ id: room, participants: 1 });
  publish([
    start,
    join,
    { ...start, id: "fake-end", kind: 48103, pubkey: "ef".repeat(32) },
  ]);
  expect(result.current?.id).toBe(room);
  rerender({ channel: "another-dm" });
  expect(result.current).toBeUndefined();
  expect(dispose).toHaveBeenCalledTimes(1);
  rerender({ channel: parent });
  expect(result.current?.id).toBe(room);
  publish([start, join, { ...start, id: "end", kind: 48103 }]);
  expect(result.current).toBeUndefined();
  publish([start, join]);
  act(() => {
    vi.advanceTimersByTime(3600_000);
  });
  expect(result.current).toBeUndefined();
  unmount();
  expect(listeners.size).toBe(0);
  store.dispose();
});

it("uses verified live starts and ends after the initial discovery read fails", async () => {
  const relay = keypair(),
    viewer = keypair();
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(48100)))
        throw new Error("Discovery unavailable");
      return [
        roster(relay, parent, [viewer.pubkey]),
        metadata(relay, parent, "Parent"),
      ].filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(
      owner.session.channels.get?.(parent)?.metadataPending,
    ).toBeUndefined(),
  );
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(1),
  );
  let view: ReturnType<typeof owner.session.observe> | undefined;
  const session = {
    ...owner.session,
    observe: (...args: Parameters<typeof owner.session.observe>) => {
      view = owner.session.observe(...args);
      return view;
    },
  };
  const { result, unmount } = renderHook(() =>
    useIncomingHuddle(session, parent),
  );
  try {
    await act(async () => {
      await vi.waitFor(() => expect(view?.snapshot().status).toBe("error"));
    });
    expect(result.current).toBeUndefined();
    const event = {
      kind: 48100,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", parent]],
      content: JSON.stringify({ ephemeral_channel_id: room }),
    };
    act(() => live?.receive([signed(viewer, event)]));
    expect(view?.snapshot().status).toBe("error");
    expect(result.current?.id).toBe(room);
    act(() =>
      live?.receive([
        signed(viewer, {
          ...event,
          kind: 48103,
          created_at: event.created_at + 1,
        }),
      ]),
    );
    expect(result.current).toBeUndefined();
  } finally {
    unmount();
    owner.dispose();
  }
});
