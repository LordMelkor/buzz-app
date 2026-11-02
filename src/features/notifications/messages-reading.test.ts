// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "../messages/use-reading";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";
import { flush, message } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
/**
 * The real reading hook over a focused, fully visible message list, against
 * the real session. Leases are recorded so tests can wait for their disposal.
 */
function mountList(
  h: Awaited<ReturnType<typeof setup>>,
  ids: readonly string[],
  { offscreen = false } = {},
) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const list = document.createElement("div");
  list.tabIndex = 0;
  document.body.append(list);
  list.focus();
  vi.spyOn(list, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const items = ids.map((id) => {
    const item = document.createElement("div");
    item.dataset.messageId = id;
    list.append(item);
    return item;
  });
  const rows = items.map((item, index) =>
    vi
      .spyOn(item, "getBoundingClientRect")
      .mockReturnValue(
        new DOMRect(0, (offscreen ? 600 : 100) + index * 100, 400, 100),
      ),
  );
  const real = h.owner.session.unread;
  const leases: { disposed: boolean }[] = [];
  const unread = {
    ...real,
    reading(channelId: string): ReadingHandle {
      const lease = real.reading(channelId);
      const record = { disposed: false };
      leases.push(record);
      return {
        ...lease,
        dispose() {
          record.disposed = true;
          lease.dispose();
        },
      };
    },
  };
  renderHook(useReading, {
    initialProps: {
      session: { unread } as unknown as RelaySession,
      channelId: "room",
      scroller: { current: list },
      settled: { current: true },
    },
  });
  /** Moves a row out of the viewport, as a user scroll does. */
  const scrollAway = (index: number) => {
    rows[index]?.mockReturnValue(new DOMRect(0, 600, 400, 100));
    list.dispatchEvent(new Event("scroll"));
  };
  /** Moves a row into the viewport, as a user scroll does. */
  const scrollInto = (index: number) => {
    rows[index]?.mockReturnValue(new DOMRect(0, 100, 400, 100));
    list.dispatchEvent(new Event("scroll"));
  };
  /** Changes a row's content in place; it stays where it is. */
  const mutate = async (index: number) => {
    items[index]?.append("edited");
    await Promise.resolve(); // MutationObserver delivery
  };
  return { leases, scrollAway, scrollInto, mutate };
}
/** Queues animation frames without running them, and counts them. */
function holdFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return frames;
}
/** Holds delivery at its permission probe, as a slow presentation would. */
function holdPresentation(h: Awaited<ReturnType<typeof setup>>) {
  let present: (() => void) | undefined;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        present = () => resolve("granted");
      }),
  );
  return {
    held: () => present !== undefined,
    present: () => present?.(),
  };
}
it.each(["in view", "window blur", "scroll away", "row mutation"] as const)(
  "Notify while viewing: after the list's own dwell read, the alert follows the view (%s)",
  async (state) => {
    const h = await setup(undefined, undefined, undefined, undefined, true);
    h.notifications.updatePreferences({ notifyWhileViewing: true });
    const row = h.make("read before presentation");
    const delivery = holdPresentation(h);
    try {
      h.emit([row], "live");
      await vi.waitFor(() => expect(delivery.held()).toBe(true));
      const list = mountList(h, [row.id]);
      const attention = () => h.owner.session.unread.attention("room", row.id);
      // Dwell completes, and its write lease is released after the read.
      await vi.waitFor(() => expect(list.leases[0]?.disposed).toBe(true));
      expect(attention()).toMatchObject({ unread: false, viewing: true });
      // The permission probe resolves before the list's next frame measures.
      const frames = holdFrames();
      if (state === "window blur") window.dispatchEvent(new Event("blur"));
      if (state === "scroll away") list.scrollAway(0);
      if (state === "row mutation") await list.mutate(0);
      if (state === "scroll away" || state === "row mutation")
        expect(frames).toHaveLength(1);
      delivery.present();
      await flush();
      expect(h.show).toHaveBeenCalledTimes(
        state === "in view" || state === "row mutation" ? 1 : 0,
      );
    } finally {
      delivery.present();
    }
  },
);
it("an unread alert stays quiet when its row scrolls into view before the list's next frame", async () => {
  const h = await setup(undefined, undefined, undefined, undefined, true);
  // Notify while viewing is off: a row in view must not alert.
  const row = h.make("scrolled into view");
  const delivery = holdPresentation(h);
  try {
    h.emit([row], "live");
    await vi.waitFor(() => expect(delivery.held()).toBe(true));
    const list = mountList(h, [row.id], { offscreen: true });
    const attention = () => h.owner.session.unread.attention("room", row.id);
    expect(attention()).toMatchObject({ unread: true, viewing: false });
    // The permission probe resolves before the list's next frame measures.
    const frames = holdFrames();
    list.scrollInto(0);
    expect(frames).toHaveLength(1);
    expect(attention()).toMatchObject({ unread: true, viewing: true });
    delivery.present();
    await flush();
    expect(h.show).not.toHaveBeenCalled();
  } finally {
    delivery.present();
  }
});
it("Notify while viewing: a row read and scrolled away stays quiet while a later row's write is pending", async () => {
  // Once armed, the first read-state write passes and the next one is held.
  let release: (() => void) | undefined;
  let armed = false;
  let writes = 0;
  const gate = () =>
    !armed || writes++ === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          release = resolve;
        });
  const h = await setup(gate, undefined, undefined, undefined, true);
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const alerted = h.make("alerted");
  // A plain channel message, so only the first row raises an alert.
  const quiet = message(h.peer, "room", "quiet", Math.floor(Date.now() / 1000));
  const delivery = holdPresentation(h);
  try {
    h.emit([alerted, quiet], "live");
    await vi.waitFor(() => expect(delivery.held()).toBe(true));
    armed = true;
    const list = mountList(h, [alerted.id, quiet.id]);
    const attention = (id: string) =>
      h.owner.session.unread.attention("room", id);
    // The first row is saved; the second row's write is still pending.
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(attention(alerted.id).unread).toBe(false);
    expect(attention(quiet.id).unread).toBe(true);
    expect(list.leases[0]?.disposed).toBe(false);
    list.scrollAway(0);
    expect(attention(alerted.id)).toMatchObject({
      unread: false,
      viewing: false,
    });
    delivery.present();
    await flush();
    expect(h.show).not.toHaveBeenCalled();
  } finally {
    delivery.present();
    release?.();
  }
});
