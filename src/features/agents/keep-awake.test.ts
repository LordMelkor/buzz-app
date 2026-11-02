// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  bindKeepAwake,
  retryKeepAwake,
  useKeepAwakeApplyError,
  type KeepAwake,
} from "./keep-awake";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

function fixture(initial: KeepAwake, working = false) {
  vi.useFakeTimers();
  let value = initial;
  const preferenceListeners = new Set<() => void>();
  const workingListeners = new Set<() => void>();
  const hold = vi.fn(async (_: boolean) => {});
  const stop = bindKeepAwake(
    {
      isWorking: () => working,
      subscribeWorking(listener) {
        workingListeners.add(listener);
        return () => void workingListeners.delete(listener);
      },
    },
    hold,
    {
      read: () => value,
      subscribe(listener) {
        preferenceListeners.add(listener);
        return () => void preferenceListeners.delete(listener);
      },
    },
  );
  stops.push(stop);
  return {
    hold,
    stop,
    held: () => hold.mock.calls.at(-1)?.[0] ?? false,
    choose(next: KeepAwake) {
      value = next;
      for (const listener of preferenceListeners) listener();
    },
    work(next: boolean) {
      working = next;
      for (const listener of workingListeners) listener();
    },
  };
}

it("never holds while Off, even with agents working", async () => {
  const keep = fixture({ mode: "off", after: 30 }, true);
  keep.work(false);
  keep.work(true);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  // Only the start lets go of what a page before a reload held.
  expect(keep.hold.mock.calls).toEqual([[false]]);
});

it("holds while On with no agent working, and lets go when it stops", async () => {
  const keep = fixture({ mode: "on", after: 30 });
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(keep.hold.mock.calls).toEqual([[true]]);
  keep.stop();
  expect(keep.hold.mock.calls).toEqual([[true], [false]]);
});

it("holds while agents work and the chosen time after, then again when one works", async () => {
  const keep = fixture({ mode: "auto", after: 30 });
  // Starting counts as the end of a turn.
  expect(keep.held()).toBe(true);
  await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
  expect(keep.held()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(keep.held()).toBe(false);

  keep.work(true);
  expect(keep.held()).toBe(true);
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
  expect(keep.held()).toBe(true);
  keep.work(false);
  await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
  expect(keep.held()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(keep.hold.mock.calls).toEqual([[true], [false], [true], [false]]);
});

it("starts the wait again when the owner changes the setting", async () => {
  const keep = fixture({ mode: "auto", after: 30 });
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  keep.choose({ mode: "auto", after: 60 });
  await vi.advanceTimersByTimeAsync(59 * 60_000);
  expect(keep.held()).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(keep.held()).toBe(false);
  keep.choose({ mode: "on", after: 60 });
  expect(keep.held()).toBe(true);
  keep.choose({ mode: "off", after: 60 });
  expect(keep.held()).toBe(false);
});

it("asks again on the next change when the host refuses", async () => {
  const keep = fixture({ mode: "off", after: 30 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  keep.hold.mockRejectedValueOnce(new Error("refused"));
  keep.choose({ mode: "on", after: 30 });
  await vi.advanceTimersByTimeAsync(0);
  keep.choose({ mode: "auto", after: 30 });
  expect(keep.hold.mock.calls).toEqual([[false], [true], [true]]);
});

it("reports a refusal until a retry of the same choice succeeds", async () => {
  const keep = fixture({ mode: "off", after: 30 });
  const error = renderHook(() => useKeepAwakeApplyError());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  keep.hold.mockRejectedValueOnce(new Error("refused"));
  keep.choose({ mode: "on", after: 30 });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(error.result.current).toBe("Couldn’t keep this Mac awake");
  // Nothing else changes, so only the retry asks again.
  await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60_000));
  expect(keep.hold.mock.calls).toEqual([[false], [true]]);
  await act(async () => retryKeepAwake());
  expect(keep.hold.mock.calls).toEqual([[false], [true], [true]]);
  expect(error.result.current).toBeNull();
  keep.stop();
});

it("ignores a late answer to a choice the owner already replaced", async () => {
  const keep = fixture({ mode: "off", after: 30 });
  const error = renderHook(() => useKeepAwakeApplyError());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let refuse!: (error: Error) => void;
  keep.hold.mockImplementationOnce(
    () => new Promise((_, reject) => (refuse = reject)),
  );
  keep.choose({ mode: "on", after: 30 });
  keep.choose({ mode: "off", after: 30 });
  await act(async () => refuse(new Error("refused")));
  expect(error.result.current).toBeNull();
  expect(keep.hold.mock.calls).toEqual([[false], [true], [false]]);
  // Settled on Off: no retry reasserts the stale On.
  await act(async () => retryKeepAwake());
  expect(keep.held()).toBe(false);
  keep.stop();
});
