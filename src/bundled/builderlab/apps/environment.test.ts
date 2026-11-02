import { afterEach, expect, it, vi } from "vitest";
import { isAppUrl, isViewerTarget, viewerAppDomain } from "./environment";

afterEach(() => vi.unstubAllEnvs());

it("uses the exact Apps domain paired with the trusted login build configuration", () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://login.example");
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_APPS_DOMAIN", "apps.example");
  expect(viewerAppDomain()).toBe("apps.example");
  expect(isAppUrl("https://counter--workspace.apps.example/report")).toBe(true);
  expect(
    isViewerTarget("https://counter--workspace.apps.example/report?q=1#part"),
  ).toBe(true);
  for (const target of [
    "https://counter.apps.other.example/",
    "https://counter.apps.example.evil.example/",
    "https://nested.counter.apps.example/",
    "https://apps.example/",
    "https://login.apps.example/",
    "https://health.apps.example/",
    "http://counter.apps.example/",
    "https://user@counter.apps.example/",
    "https://counter.apps.example:8443/",
  ])
    expect(isViewerTarget(target)).toBe(false);
});

it("keeps native SSO off without an Apps domain and honors an explicit disable", () => {
  expect(viewerAppDomain("https://login.example", undefined)).toBe("");
  expect(viewerAppDomain("https://app.builderlab.xyz", "")).toBe("");
  expect(
    isViewerTarget(
      "https://counter.apps.example/",
      "https://login.example",
      "",
    ),
  ).toBe(false);
});
