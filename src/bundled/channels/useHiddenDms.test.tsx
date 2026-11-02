// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { IncomingListener } from "../../features/relay/incoming";
import type { ChannelList } from "../../features/relay/contracts";
import { readView } from "../../shared/view-state";
import { useHiddenDms } from "./useHiddenDms";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function fixture() {
  const list: ChannelList = {
    status: "ready",
    channels: [
      { id: "dm", channelType: "dm" } as ChannelList["channels"][number],
    ],
  };
  let latest: { id: string; createdAt: number } | undefined = {
    id: "before",
    createdAt: 90,
  };
  const listeners = new Set<() => void>();
  const incoming = new Set<IncomingListener>();
  type ObserveSend = Parameters<
    NonNullable<RelaySession["outbox"]>["observeSend"]
  >[0];
  const outgoing = new Set<ObserveSend>();
  const opened = new Set<(id: string) => void>();
  let onRead = () => {};
  let nextRead: Promise<void> | undefined;
  let historyIds = ["before"];
  let failures = 0;
  const read = vi.fn(async (filters: readonly { limit: number }[]) => {
    if (failures > 0) {
      failures--;
      throw new Error("Temporary relay failure");
    }
    onRead();
    const held = nextRead;
    nextRead = undefined;
    if (held) await held;
    return historyIds.slice(0, filters[0]?.limit).map((id) => ({ id }));
  });
  const session = {
    channels: {
      list: () => ({
        channels: [{ id: "dm", name: "DM", channelType: "dm" }],
      }),
    },
    read,
    directMessages: {
      subscribeOpened(listener: (id: string) => void) {
        opened.add(listener);
        return () => opened.delete(listener);
      },
    },
    outbox: {
      observeSend(listener: ObserveSend) {
        outgoing.add(listener);
        return () => outgoing.delete(listener);
      },
    },
    unread: {
      snapshot: () => ({ latestMessage: latest }),
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    subscribeIncoming(listener: IncomingListener) {
      incoming.add(listener);
      return () => incoming.delete(listener);
    },
  } as unknown as RelaySession;
  return {
    session,
    list,
    read,
    onNextRead(callback: () => void) {
      onRead = callback;
    },
    holdNextRead() {
      let release = () => {};
      nextRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    history(ids: string[]) {
      historyIds = ids;
    },
    failNextRead() {
      failures++;
    },
    evidence(id: string, createdAt: number) {
      latest = { id, createdAt };
      for (const listener of listeners) listener();
    },
    clearHead() {
      latest = undefined;
      for (const listener of listeners) listener();
    },
    receive(channelId: string) {
      for (const listener of incoming)
        listener([
          {
            channelId,
            messageId: "incoming",
            createdAt: 100,
            authorId: "sender",
            previewContent: "hello",
          },
        ]);
    },
    open(channelId: string) {
      for (const listener of opened) listener(channelId);
    },
    deliver(channelId: string) {
      for (const listener of outgoing)
        listener(
          { kind: 9, tags: [["h", channelId]] } as Parameters<ObserveSend>[0],
          new AbortController().signal,
        )?.([]);
    },
    pendingDelivery(channelId: string) {
      const listener = [...outgoing][0];
      return listener?.(
        { kind: 9, tags: [["h", channelId]] } as Parameters<ObserveSend>[0],
        new AbortController().signal,
      );
    },
  };
}

it("hides per scope, survives remount, and restores on later verified activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  expect(first.result.current.hiddenIds.has("dm")).toBe(true);
  first.unmount();

  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  const other = renderHook(() =>
    useHiddenDms("community:bob", h.session, h.list),
  );
  expect(other.result.current.hiddenIds.has("dm")).toBe(false);

  act(() => h.evidence("before", 90));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.evidence("new-message", 100));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("restores a hidden DM on a new live message, including when its timestamp is old", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  act(() => h.receive("different"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.receive("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("checks a hidden DM directly on return for messages missed while closed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  first.unmount();
  h.onNextRead(() => h.evidence("offline-message", 98));
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [9, 40002, 40008], "#h": ["dm"], limit: 100 }],
    expect.objectContaining({ priority: "background" }),
  );
});

it("waits for the roster before checking a restored DM for missed activity", async () => {
  const h = fixture();
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  first.unmount();

  let list: ChannelList = { status: "idle", channels: [] };
  h.read.mockClear();
  h.onNextRead(() => h.evidence("offline-message", 91));
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, list),
  );
  expect(h.read).not.toHaveBeenCalled();
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);

  list = h.list;
  restored.rerender();
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("does not restart hidden history reads for a preview-only roster update", async () => {
  const h = fixture();
  let list = h.list;
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, list),
  );
  act(() => view.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  h.read.mockClear();
  list = {
    ...h.list,
    channels: h.list.channels.map((channel) => ({
      ...channel,
      preview: "changed",
    })),
  };
  view.rerender();
  expect(h.read).not.toHaveBeenCalled();
});

it("does not restore from historical evidence when the head was unknown at hide", async () => {
  const h = fixture();
  h.clearHead();
  h.onNextRead(() => h.evidence("before", 90));
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.evidence("new-message", 91));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("persists a hide while its first baseline read is pending", () => {
  const h = fixture();
  h.clearHead();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  expect(readView("community:alice", "hidden-dms", [])).toEqual([{ id: "dm" }]);
  view.unmount();
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
});

it("restores for an offline message that sorts behind the previous head", async () => {
  const h = fixture();
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  first.unmount();
  h.history(["before", "late-old"]);
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("leaves hidden-DM history retries to the session read", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.failNextRead();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
});

it("keeps a DM hidden when deleting its latest message reveals older history", async () => {
  const h = fixture();
  h.history(["before", "older"]);
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  act(() => h.evidence("older", 89));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  view.unmount();
  h.history(["older"]);
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.evidence("new-message", 91));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("restores when a deleted head and a late message appear together", async () => {
  const h = fixture();
  h.history(["before", "older"]);
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  first.unmount();
  h.history(["older", "late-old"]);
  h.evidence("older", 89);
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("keeps a DM hidden when deletion slides the read window back", async () => {
  const h = fixture();
  const history = [
    "before",
    ...Array.from({ length: 99 }, (_, i) => `older-${i}`),
  ];
  h.history(history);
  const first = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => first.result.current.hide("dm"));
  await act(async () => {
    await Promise.resolve();
  });
  first.unmount();
  h.history(history.slice(1));
  h.evidence("older-0", 89);
  const restored = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
});

it("restores a hidden DM after an outgoing message is delivered", () => {
  const h = fixture();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  act(() => h.deliver("different"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.deliver("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("restores an outgoing send after history enrichment without head advancement", async () => {
  const h = fixture();
  const release = h.holdNextRead();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  expect(h.read).toHaveBeenCalledTimes(1);
  const finish = h.pendingDelivery("dm");

  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(readView("community:alice", "hidden-dms", [])).toEqual([
    {
      id: "dm",
      baseline: { id: "before", createdAt: 90 },
      knownIds: ["before"],
    },
  ]);
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);

  act(() => finish?.([]));
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "dm" })
      .latestMessage,
  ).toEqual({ id: "before", createdAt: 90 });
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("does not restore a DM hidden again after an older send began", async () => {
  const h = fixture();
  const release = h.holdNextRead();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  const finish = h.pendingDelivery("dm");
  expect(finish).toBeTypeOf("function");
  await act(async () => {
    release();
    await Promise.resolve();
  });
  act(() => view.result.current.hide("dm"));
  act(() => finish?.([]));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
});

it("restores a hidden DM when it is opened again", () => {
  const h = fixture();
  const view = renderHook(() =>
    useHiddenDms("community:alice", h.session, h.list),
  );
  act(() => view.result.current.hide("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.open("other"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.open("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
  expect(readView("community:alice", "hidden-dms", [])).toEqual([]);
});
