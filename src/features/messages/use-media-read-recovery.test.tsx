// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMediaReadRecovery } from "./use-media-read-recovery";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const failed = vi.fn(),
    recovered = vi.fn();
  function Probe({ source }: { source: string }) {
    const { recover } = useMediaReadRecovery(source, failed, recovered);
    return (
      <audio
        preload="none"
        src={source}
        onError={(event) => {
          if (!recover(event.currentTarget)) failed();
        }}
      >
        <track kind="captions" />
      </audio>
    );
  }
  const mounted = render(<Probe source="/first.mp3" />);
  const element = mounted.container.querySelector("audio");
  if (!element) throw new Error("Audio fixture missing");
  const error = (code = 2) => {
    Object.defineProperty(element, "error", {
      configurable: true,
      value: { code },
    });
    fireEvent.error(element);
  };
  return {
    ...mounted,
    element,
    error,
    failed,
    recovered,
    change: () => mounted.rerender(<Probe source="/second.mp3" />),
  };
}
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

it("reloads a network failure quietly after backoff and preserves explicit playback", async () => {
  const h = setup();
  const play = vi.spyOn(h.element, "play");
  h.error();
  await advance(749);
  expect(h.element.load).not.toHaveBeenCalled();
  expect(h.failed).not.toHaveBeenCalled();
  await advance(1);
  expect(h.element.load).toHaveBeenCalledOnce();
  expect(h.element.preload).toBe("metadata");
  fireEvent.loadedMetadata(h.element);
  await advance(0);
  expect(h.recovered).toHaveBeenCalledOnce();
  expect(h.element.preload).toBe("none");
  expect(h.failed).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
});

it("surfaces a later failure of a recovered source instead of reloading again", async () => {
  const h = setup();
  h.error();
  await advance(750);
  fireEvent.loadedMetadata(h.element);
  await advance(0);
  expect(h.recovered).toHaveBeenCalledOnce();
  h.error();
  await advance(7000);
  expect(h.element.load).toHaveBeenCalledOnce();
  expect(h.failed).toHaveBeenCalledOnce();
});

it("counts the initial browser failure and exposes failure after three reloads", async () => {
  const h = setup();
  h.error();
  for (const [index, delay] of [750, 1500, 3000].entries()) {
    await advance(delay);
    expect(h.element.load).toHaveBeenCalledTimes(index + 1);
    h.error();
  }
  await advance(0);
  expect(h.failed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["unmount", "source"])("%s cancels future reloads", async (action) => {
  const h = setup();
  h.error();
  await advance(0);
  if (action === "unmount") h.unmount();
  else h.change();
  await advance(7000);
  expect(h.element.load).not.toHaveBeenCalled();
  expect(h.failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([1, 3, 4])("leaves media error %s explicit", async (code) => {
  const h = setup();
  h.error(code);
  await advance(7000);
  expect(h.failed).toHaveBeenCalledOnce();
  expect(h.element.load).not.toHaveBeenCalled();
});
