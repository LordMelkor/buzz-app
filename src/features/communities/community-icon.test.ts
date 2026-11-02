import { afterEach, expect, it, vi } from "vitest";
import {
  communityIcon,
  communityPresentation,
  fetchCommunityPresentation,
} from "./community-icon";

it("accepts bounded image URLs and rejects executable or malformed relay metadata", () => {
  expect(communityIcon("https://images.example/icon.png")).toBe(
    "https://images.example/icon.png",
  );
  expect(communityIcon("https://images.example/icon@2x.png")).toBe(
    "https://images.example/icon@2x.png",
  );
  expect(communityIcon("https://images.example/icon.png?size=@2x")).toBe(
    "https://images.example/icon.png?size=@2x",
  );
  const emojiSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ffe75c"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🐝</text></svg>';
  const emojiIcon = `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`;
  expect(communityIcon(emojiIcon)).toBe(emojiIcon);
  expect(
    communityIcon(
      `data:image/svg+xml,${encodeURIComponent(emojiSvg.replace("🐝", "<script>alert(1)</script>"))}`,
    ),
  ).toBeUndefined();
  expect(
    communityIcon(`data:image/svg+xml,${"%".repeat(98_304)}`),
  ).toBeUndefined();
  expect(communityIcon("data:image/webp;base64,UklGRg==")).toBe(
    "data:image/webp;base64,UklGRg==",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGI+",
    "data:image/png;base64,x".repeat(6000),
    "https://images.example/a\nb",
    "https://user:pass@images.example/a",
    "https://user@images.example/a",
    "https://images.example:bad/a",
    "http://images.example/icon.png",
    null,
  ])
    expect(communityIcon(value)).toBeUndefined();
});

afterEach(() => vi.unstubAllGlobals());

it("registers before NIP-11 discovery without opening a session", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      return input.endsWith("/icon-info")
        ? Response.json({
            name: "Published",
            icon: "data:image/png;base64,YQ==",
          })
        : Response.json({});
    }),
  );
  expect(
    await fetchCommunityPresentation(
      "https://relay.example",
      new AbortController().signal,
    ),
  ).toEqual({
    publishedName: "Published",
    publishedIcon: "data:image/png;base64,YQ==",
  });
  expect(calls).toEqual([
    "POST /api/relay/register",
    "GET /api/relay/https%3A%2F%2Frelay.example/icon-info",
  ]);
});

it("resolves canonical community presentation with local names and safe published icons", () => {
  expect(
    communityPresentation("wss://RELAY.example:443/", [
      { id: "https://other.example", name: "Other" },
      {
        id: "https://relay.example",
        name: "Saved",
        publishedName: "Published",
        localName: "Local",
        icon: "https://images.example/old.png",
        publishedIcon: "https://images.example/current.png",
      },
    ]),
  ).toEqual({
    id: "https://relay.example",
    name: "Local",
    src: "https://images.example/current.png",
  });
  expect(communityPresentation("wss://relay.example")).toEqual({
    id: "https://relay.example",
    name: "relay.example",
    src: undefined,
  });
});
