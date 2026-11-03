import { afterEach, beforeEach, expect, it, vi } from "vitest";

const decode = vi.fn();
beforeEach(() => {
  vi.resetModules();
  decode.mockReset().mockResolvedValue({
    duration: 1.35,
    getChannelData: () => Float32Array.from([0, 0.5, -1, 0.2]),
  });
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = decode;
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("derives duration and a compact waveform without starting playback", async () => {
  const { analyzeAudio } = await import("./analyze-audio");
  const result = await analyzeAudio("blob:clip", new AbortController().signal);
  expect(result.duration).toBe(1.35);
  expect([...result.waveform]).toEqual([0, 0.5, 1, expect.closeTo(0.2)]);
});
it("rejects oversized streamed bodies before decoding, even without Content-Length", async () => {
  const cancel = vi.fn();
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        },
        cancel,
      }),
    ),
  );
  const { analyzeAudio } = await import("./analyze-audio");
  await expect(
    analyzeAudio("blob:large", new AbortController().signal),
  ).rejects.toThrow("too large");
  expect(decode).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});
it("does not fetch cancelled queued clips and discards decoding completed after cancellation", async () => {
  let finish!: (value: unknown) => void;
  decode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { analyzeAudio } = await import("./analyze-audio");
  const first = new AbortController();
  const result = analyzeAudio("blob:first", first.signal);
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  const second = new AbortController();
  const queued = analyzeAudio("blob:second", second.signal);
  const queuedRejected = expect(queued).rejects.toThrow();
  first.abort();
  second.abort();
  finish({ duration: 2, getChannelData: () => new Float32Array([1]) });
  await rejected;
  await queuedRejected;
  expect(fetch).toHaveBeenCalledOnce();
});
