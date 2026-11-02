// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createHuddleRing } from "./ring";
import type { HuddleSnapshot } from "./service";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function harness() {
  vi.useFakeTimers();
  let snapshot: HuddleSnapshot = {
    phase: "idle",
    participants: [],
    muted: false,
  };
  const listeners = new Set<() => void>();
  const audio = document.createElement("audio");
  const play = vi.spyOn(audio, "play").mockResolvedValue();
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  vi.spyOn(audio, "load").mockImplementation(() => {});
  const dispose = createHuddleRing(
    {
      snapshot: () => snapshot,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    () => audio,
  );
  disposers.push(dispose);
  const update = (
    phase: HuddleSnapshot["phase"],
    id = "request",
    room = "request",
  ) => {
    snapshot = { ...snapshot, phase, id, room };
    for (const fn of listeners) fn();
  };
  return { audio, play, pause, update, dispose };
}

it("rings once per request and leaves a second of silence after the clip ends", () => {
  const h = harness();
  expect(h.play).not.toHaveBeenCalled();
  h.update("incoming");
  h.update("incoming");
  expect(h.play).toHaveBeenCalledTimes(1);
  h.audio.dispatchEvent(new Event("ended"));
  vi.advanceTimersByTime(999);
  expect(h.play).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(h.play).toHaveBeenCalledTimes(2);
  h.audio.dispatchEvent(new Event("ended"));
  h.update("connecting");
  expect(h.pause).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  expect(h.play).toHaveBeenCalledTimes(2);
});

it.each(["idle", "error", "connected"] as const)(
  "stops on %s and releases playback on disposal",
  (phase) => {
    const h = harness();
    h.update("incoming");
    h.audio.dispatchEvent(new Event("ended"));
    h.update(phase);
    vi.advanceTimersByTime(5000);
    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.pause).toHaveBeenCalledTimes(1);
    h.update("incoming", "next");
    h.dispose();
    h.audio.dispatchEvent(new Event("ended"));
    vi.advanceTimersByTime(5000);
    expect(h.play).toHaveBeenCalledTimes(2);
    expect(h.pause).toHaveBeenCalledTimes(2);
  },
);

it("retries blocked autoplay on interaction and removes that retry when dismissed", async () => {
  const h = harness();
  h.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  h.update("incoming");
  await Promise.resolve();
  window.dispatchEvent(new Event("pointerdown"));
  expect(h.play).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("keydown"));
  expect(h.play).toHaveBeenCalledTimes(2);
  h.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  h.update("incoming", "next");
  await Promise.resolve();
  h.update("idle");
  window.dispatchEvent(new Event("pointerdown"));
  expect(h.play).toHaveBeenCalledTimes(3);
});

it("ignores a late autoplay rejection after the request is gone", async () => {
  const h = harness();
  let reject!: (error: Error) => void;
  h.play.mockReturnValueOnce(
    new Promise<void>((_, no) => {
      reject = no;
    }),
  );
  h.update("incoming");
  h.update("idle");
  reject(new DOMException("blocked", "NotAllowedError"));
  await Promise.resolve();
  window.dispatchEvent(new Event("pointerdown"));
  expect(h.play).toHaveBeenCalledTimes(1);
});

it("keeps an answered request silent through retry recovery but rings for a new request", () => {
  const h = harness();
  h.update("incoming");
  h.update("connecting", "attempt-id");
  h.update("leaving", "attempt-id");
  h.update("error", "attempt-id");
  h.update("incoming");
  h.audio.dispatchEvent(new Event("ended"));
  vi.advanceTimersByTime(5000);
  expect(h.play).toHaveBeenCalledTimes(1);
  expect(h.pause).toHaveBeenCalledTimes(1);
  h.update("incoming", "new-request");
  expect(h.play).toHaveBeenCalledTimes(2);
});

it("does not silence an invitation when an unrelated call fails", () => {
  const h = harness();
  h.update("incoming");
  h.update("connecting", "attempt-b", "room-b");
  h.update("error", "attempt-b", "room-b");
  h.update("incoming");
  expect(h.play).toHaveBeenCalledTimes(2);
});
