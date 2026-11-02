// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerSent } from "./useComposerSent";

afterEach(cleanup);

it("keeps onSend stable across parent renders and records the sent message", () => {
  const setSent = vi.fn();
  const view = renderHook(
    ({ channelId }) => useComposerSent(channelId, setSent),
    { initialProps: { channelId: "a" } },
  );
  const initial = view.result.current;
  view.rerender({ channelId: "a" });
  expect(view.result.current).toBe(initial);
  act(() => view.result.current("one"));
  expect(setSent).toHaveBeenCalledWith({ channelId: "a", id: "one" });
  view.rerender({ channelId: "b" });
  expect(view.result.current).not.toBe(initial);
  act(() => view.result.current("two"));
  expect(setSent).toHaveBeenLastCalledWith({ channelId: "b", id: "two" });
});
