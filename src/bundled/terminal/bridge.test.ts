import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.each([
  [false, "MacIntel", false],
  [true, "Win32", false],
  [true, "MacIntel", true],
  [true, "Linux x86_64", true],
  [true, "", false],
])(
  "desktop=%s platform=%s exposes terminal=%s",
  async (desktop, platform, available) => {
    vi.mocked(isTauri).mockReturnValue(desktop);
    vi.stubGlobal("navigator", { platform });
    const { nativeBridge } = await import("./bridge");
    expect(nativeBridge.available).toBe(available);
  },
);
it("decodes the raw read body's trailing exit flag", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const { nativeBridge } = await import("./bridge");
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([65, 66, 1]).buffer);
  await expect(nativeBridge.read("owner", "pty")).resolves.toEqual({
    data: new Uint8Array([65, 66]),
    exited: true,
  });
  expect(invoke).toHaveBeenCalledWith("terminal_read", {
    owner: "owner",
    id: "pty",
  });
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([0]).buffer);
  await expect(nativeBridge.read("owner", "pty")).resolves.toEqual({
    data: new Uint8Array(),
    exited: false,
  });
});
