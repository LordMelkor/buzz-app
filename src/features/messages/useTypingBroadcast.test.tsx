// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTypingBroadcast } from "./useTypingBroadcast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("publishes only on edits, throttles bursts and cancels the old conversation lifetime", () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(1_800_000_000_000);
  const send = vi.fn(
    async (_id: string, _root: string | undefined, _signal: AbortSignal) => {},
  );
  const { result, rerender, unmount } = renderHook(
    ({
      channel,
      root,
      enabled,
    }: {
      channel: string;
      root?: string | undefined;
      enabled: boolean;
    }) => useTypingBroadcast(send, channel, root, enabled),
    {
      initialProps: {
        channel: "dm",
        root: undefined as string | undefined,
        enabled: true,
      },
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    },
  );
  expect(send).not.toHaveBeenCalled();
  act(() => result.current());
  const first = send.mock.calls[0]?.[2];
  expect(first?.aborted).toBe(false);
  act(() => {
    result.current();
    vi.advanceTimersByTime(2_999);
    result.current();
  });
  expect(send).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(1);
    result.current();
  });
  expect(send).toHaveBeenCalledTimes(2);
  rerender({ channel: "dm", root: "a".repeat(64), enabled: true });
  expect(first?.aborted).toBe(true);
  act(() => result.current());
  expect(send).toHaveBeenLastCalledWith(
    "dm",
    "a".repeat(64),
    expect.any(AbortSignal),
  );
  const thread = send.mock.calls.at(-1)?.[2];
  const stale = result.current;
  rerender({ channel: "other", root: undefined, enabled: false });
  expect(thread?.aborted).toBe(true);
  act(() => {
    result.current();
    stale();
    vi.advanceTimersByTime(20_000);
  });
  expect(send).toHaveBeenCalledTimes(3);
  rerender({ channel: "other", root: undefined, enabled: true });
  act(() => result.current());
  const last = send.mock.calls.at(-1)?.[2];
  unmount();
  expect(last?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([-3_600_000, 3_600_000])(
  "keeps the three-second interval across a %ims wall-clock jump",
  (jump) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const send = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useTypingBroadcast(send, "dm", undefined, true),
    );
    act(() => result.current());
    vi.setSystemTime(Date.now() + jump);
    act(() => {
      result.current();
      vi.advanceTimersByTime(2_999);
      result.current();
    });
    expect(send).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
      result.current();
    });
    expect(send).toHaveBeenCalledTimes(2);
  },
);

it("does not retry a rejected pulse or require a writable host", async () => {
  const send = vi.fn(async () => {
    throw new Error("disconnected");
  });
  const { result } = renderHook(() =>
    useTypingBroadcast(send, "dm", undefined, true),
  );
  await act(async () => {
    result.current();
    await Promise.resolve();
  });
  expect(send).toHaveBeenCalledTimes(1);
  const unavailable = renderHook(() =>
    useTypingBroadcast(undefined, "dm", undefined, true),
  );
  expect(() => unavailable.result.current()).not.toThrow();
});
