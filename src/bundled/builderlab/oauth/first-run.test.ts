import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import { bundledHost, firstRunCredential } from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const catalog = (enabled: boolean): StorageResult => ({
  status: "ready",
  catalog: {
    profile: "default",
    location: "/profiles/default",
    plugins: [
      {
        manifest: { ...manifest, apiVersion: 1 },
        source: "bundled",
        revision: "bundled",
        enabled,
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  },
  externalPluginsPaused: false,
});

it("requests under the bundled Builderlab grant without a plugin owner", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: "{}",
  });
  const request = { url: "https://app.builderlab.xyz/api/goose/v1/auth/me" };
  await bundledHost.request(request);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "block.builderlab",
    revision: "bundled",
    request,
  });
  expect(await bundledHost.runCommand("any")).toBeNull();
});

it("starts the native browser handoff at the configured build URL", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
  // A refused listener ends the attempt before any exchange request.
  vi.mocked(invoke).mockRejectedValueOnce("listener unavailable");
  await expect(
    firstRunCredential(new AbortController().signal),
  ).rejects.toThrow("Could not complete");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(1, "plugin_catalog");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "oauth_callback_begin",
    expect.objectContaining({
      authorizationUrl: expect.stringMatching(
        /^https:\/\/builderlab\.example\/api\/goose\/v1\/auth\/login\?/,
      ),
      useState: true,
    }),
  );
});

// A disabled bundled plugin has no native grant, so its code exchange fails.
it.each([
  [
    "Builderlab is turned off",
    () => vi.mocked(invoke).mockResolvedValueOnce(catalog(false)),
    "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
  ],
  [
    "the plugin catalog cannot be read",
    () => vi.mocked(invoke).mockRejectedValueOnce("Plugin manager unavailable"),
    "Could not complete Builderlab sign-in. Try again.",
  ],
])(
  "refuses before opening the browser when %s",
  async (_label, answer, message) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    answer();
    await expect(
      firstRunCredential(new AbortController().signal),
    ).rejects.toThrow(new Error(message));
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  },
);
