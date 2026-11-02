import { afterEach, expect, it, vi } from "vitest";
import { createAudioSettings } from "./audio-settings";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () => [
      { deviceId: "default", kind: "audioinput", label: "Default" },
      { deviceId: "mic", kind: "audioinput", label: "USB mic" },
      { deviceId: "speaker", kind: "audiooutput", label: "Speakers" },
    ]),
  });
  vi.stubGlobal("navigator", { mediaDevices: media });
  const input = vi.fn(async (_id: string) => {});
  const output = vi.fn(async (_id: string) => {});
  const settings = createAudioSettings(input, output);
  return { media, input, output, settings };
}
it("enumerates devices, refreshes hotplug changes and commits only successful selections", async () => {
  const h = setup();
  try {
    await vi.waitFor(() => expect(h.settings.snapshot().loading).toBe(false));
    expect(h.settings.snapshot().inputs).toEqual([
      { id: "mic", label: "USB mic" },
    ]);
    await h.settings.select("input", "mic");
    expect(h.input).toHaveBeenCalledWith("mic");
    expect(h.settings.snapshot().input).toBe("mic");
    h.input.mockRejectedValueOnce(new Error("permission"));
    await h.settings.select("input", "");
    expect(h.settings.snapshot()).toMatchObject({ input: "mic", busy: false });
    expect(h.settings.snapshot().error).toContain("previous device");
    await h.settings.select("output", "speaker");
    expect(h.output).toHaveBeenCalledWith("speaker");
    h.media.enumerateDevices.mockResolvedValueOnce([]);
    h.media.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(h.settings.snapshot().inputs).toEqual([]));
    await h.settings.select("input", "mic");
    expect(h.input).toHaveBeenCalledTimes(2);
    expect(h.settings.snapshot().error).toContain("no longer available");
    await h.settings.select("input", "");
    expect(h.settings.snapshot().input).toBe("");
  } finally {
    h.settings.close();
  }
});
it("serializes changes and ignores late results after closing", async () => {
  const h = setup();
  let finish = () => {};
  h.input.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await h.settings.refresh();
  const notify = vi.fn();
  h.settings.subscribe(notify);
  const selecting = h.settings.select("input", "mic");
  expect(h.settings.snapshot().busy).toBe(true);
  await h.settings.select("output", "speaker");
  expect(h.output).not.toHaveBeenCalled();
  h.settings.close();
  notify.mockClear();
  h.media.enumerateDevices.mockClear();
  h.media.dispatchEvent(new Event("devicechange"));
  finish();
  await selecting;
  expect(notify).not.toHaveBeenCalled();
  expect(h.media.enumerateDevices).not.toHaveBeenCalled();
});
it("reports enumeration failures and retries without capturing audio", async () => {
  const h = setup();
  try {
    h.media.enumerateDevices.mockRejectedValueOnce(new Error("unavailable"));
    await h.settings.refresh();
    expect(h.settings.snapshot().error).toContain("Couldn’t list");
    await h.settings.refresh();
    expect(h.settings.snapshot().error).toBeUndefined();
    expect(h.input).not.toHaveBeenCalled();
    expect(h.output).not.toHaveBeenCalled();
  } finally {
    h.settings.close();
  }
});
