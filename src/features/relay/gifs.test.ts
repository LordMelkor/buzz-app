import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  communityFromScope,
  gifMarkdown,
  relaySupportsKlipy,
  fetchKlipyGifs,
  normalizeKlipyGifs,
  relayKlipySearchPath,
} from "./gifs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("native GIF search follows only the advertised relay route, never the broker", async () => {
  vi.stubGlobal("navigator", { platform: "MacIntel", language: "en-US" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No broker");
    }),
  );
  const paths: string[] = [];
  let status = 503;
  let search = "https://other.test/gifs/search";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("relay_http");
    const { community, path, body } = args as {
      community: string;
      path: string;
      body: string | null;
    };
    expect(community).toBe("https://native-gifs.test");
    paths.push(path);
    if (path === "/")
      return {
        status,
        headers: {},
        body: JSON.stringify({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search },
        }),
      };
    expect(path).toBe("/gifs/search");
    expect(JSON.parse(body ?? "null")).toMatchObject({
      query: "wave",
      locale: "en-US",
    });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ result: true, data: { data: [] } }),
    };
  });
  // Neither a failed read nor an unsupported route is remembered: discovery
  // is repeated until the relay advertises its own search route.
  await expect(relaySupportsKlipy("https://native-gifs.test")).rejects.toThrow(
    "Community discovery failed",
  );
  status = 200;
  expect(await relaySupportsKlipy("https://native-gifs.test")).toBe(false);
  await expect(
    fetchKlipyGifs("https://native-gifs.test", "wave"),
  ).rejects.toThrow("unavailable");
  expect(paths).toEqual(["/", "/", "/"]);
  search = "/gifs/search";
  expect(await relaySupportsKlipy("https://native-gifs.test")).toBe(true);
  expect(await fetchKlipyGifs("https://native-gifs.test", " wave ")).toEqual(
    [],
  );
  expect(await fetchKlipyGifs("https://native-gifs.test", "wave")).toEqual([]);
  // The supported route is read once; later searches do not repeat discovery.
  expect(paths).toEqual(["/", "/", "/", "/", "/gifs/search", "/gifs/search"]);
  const aborted = AbortSignal.abort();
  await expect(
    fetchKlipyGifs("https://native-gifs.test", "wave", aborted),
  ).rejects.toBe(aborted.reason);
  expect(paths).toHaveLength(6);
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["http", "transport", "provider"])(
  "native GIF search forgets a stale route after a %s failure",
  async (failure) => {
    vi.stubGlobal("navigator", { platform: "MacIntel", language: "en-US" });
    vi.stubEnv("VITE_BUZZ_LIVE", "0");
    const community = `https://gif-${failure}-failure.test`;
    const paths: string[] = [];
    let supported = true;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { path } = args as { path: string };
      paths.push(path);
      if (path === "/")
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            supported_extensions: supported ? ["buzz-gif"] : [],
            gif: { provider: "klipy", search: "/gifs/search" },
          }),
        };
      expect(path).toBe("/gifs/search");
      if (!supported && failure === "transport")
        throw new Error("Transport failed");
      return {
        status: !supported && failure === "http" ? 404 : 200,
        headers: {},
        body: JSON.stringify({ result: supported, data: { data: [] } }),
      };
    });
    expect(await relaySupportsKlipy(community)).toBe(true);
    supported = false;
    // The first search uses the previously discovered route and exposes its
    // failure. The next capability check must read the relay again.
    await expect(fetchKlipyGifs(community, "wave")).rejects.toThrow(
      failure === "http"
        ? "GIF request failed (404)"
        : failure === "transport"
          ? "Transport failed"
          : "GIF search failed",
    );
    expect(await relaySupportsKlipy(community)).toBe(false);
    await expect(fetchKlipyGifs(community, "wave")).rejects.toThrow(
      "unavailable",
    );
    expect(paths).toEqual(["/", "/gifs/search", "/", "/"]);
    // Negative discovery is still not cached; re-enabling GIFs recovers.
    supported = true;
    expect(await relaySupportsKlipy(community)).toBe(true);
    expect(await fetchKlipyGifs(community, "wave")).toEqual([]);
    expect(await fetchKlipyGifs(community, "wave")).toEqual([]);
    expect(paths).toEqual([
      "/",
      "/gifs/search",
      "/",
      "/",
      "/",
      "/gifs/search",
      "/gifs/search",
    ]);
  },
);

test("canceling a native GIF search cancels it natively and retains the shared capability", async () => {
  vi.stubGlobal("navigator", { platform: "MacIntel", language: "en-US" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  const community = "https://gif-canceled-search.test";
  const paths: string[] = [];
  const ids: (string | undefined)[] = [];
  const cancelled: string[] = [];
  const controller = new AbortController();
  const reason = new Error("Search canceled");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "relay_http_cancel") {
      cancelled.push((args as { id: string }).id);
      return undefined;
    }
    const { path, id } = args as { path: string; id?: string };
    paths.push(path);
    ids.push(id);
    if (path === "/")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search: "/gifs/search" },
        }),
      };
    controller.abort(reason);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ result: true, data: { data: [] } }),
    };
  });
  expect(await relaySupportsKlipy(community)).toBe(true);
  await expect(
    fetchKlipyGifs(community, "wave", controller.signal),
  ).rejects.toBe(reason);
  expect(await relaySupportsKlipy(community)).toBe(true);
  expect(paths).toEqual(["/", "/gifs/search"]);
  // Discovery is not cancellable; the search is, under its own id.
  expect(ids[0]).toBeUndefined();
  expect(cancelled).toEqual([ids[1]]);
  expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
});

const asset = (url: string, width = 320, height = 180) => ({
  url,
  width,
  height,
  size: 1234,
});

describe("relay KLIPY capability", () => {
  test("accepts only the advertised relay-relative provider path", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBe("/gifs/search");
    for (const search of [
      "https://provider.invalid/search",
      "//provider.invalid/search",
      "/gifs/../secret",
      "/gifs/search?key=secret",
      "/gifs/%2e%2e/secret",
    ])
      expect(
        relayKlipySearchPath({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search },
        }),
      ).toBeNull();
  });

  test("requires both the extension and KLIPY provider", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: [],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBeNull();
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "other", search: "/gifs/search" },
      }),
    ).toBeNull();
  });
});

test("communityFromScope separates an HTTPS community from its viewer", () => {
  const viewer = "a".repeat(64);
  expect(communityFromScope(`https://buzz.example:${viewer}`)).toBe(
    "https://buzz.example",
  );
  expect(communityFromScope(`http://buzz.example:${viewer}`)).toBeNull();
  expect(communityFromScope("not-a-session-scope")).toBeNull();
});

test("normalizes usable GIF records and rejects unsafe or incomplete media", () => {
  expect(
    normalizeKlipyGifs([
      {
        id: 7,
        type: "gif",
        slug: "hello",
        title: " Hello ",
        file: {
          md: { gif: asset("https://cdn.example/original.gif") },
          sm: { webp: asset("https://cdn.example/preview.webp", 160, 90) },
        },
      },
      {
        type: "gif",
        slug: "unsafe",
        file: { md: { gif: asset("http://cdn.example/unsafe.gif") } },
      },
      { type: "ad", slug: "advertisement", file: {} },
    ]),
  ).toEqual([
    {
      id: 7,
      slug: "hello",
      title: "Hello",
      original: asset("https://cdn.example/original.gif"),
      preview: asset("https://cdn.example/preview.webp", 160, 90),
    },
  ]);
});

test("gifMarkdown produces attachment syntax without malformed alt text", () => {
  expect(
    gifMarkdown({
      id: 1,
      slug: "wave",
      title: "Wave [hello]",
      original: asset("https://cdn.example/wave(test).gif"),
      preview: asset("https://cdn.example/wave.webp"),
    }),
  ).toBe("![Wave hello](https://cdn.example/wave%28test%29.gif)");
});
