import { retryRead } from "./read-retry";
import { ReadError, transientStatus } from "./errors";
import { nativeIdentityEnabled } from "../identity/service";
import {
  relayKlipySearchPath,
  type RelayGifSearchInfo,
} from "./gif-capability";
import { nativeRelayInfo, nativeRelayRequest } from "./native";

export { relayKlipySearchPath } from "./gif-capability";

type KlipyAsset = {
  height?: number;
  size?: number;
  url?: string;
  width?: number;
};

type KlipyFileSet = {
  gif?: KlipyAsset;
  webp?: KlipyAsset;
};

type KlipyRawGif = {
  file?: {
    hd?: KlipyFileSet;
    md?: KlipyFileSet;
    sm?: KlipyFileSet;
    xs?: KlipyFileSet;
  };
  id?: number;
  slug?: string;
  title?: string;
  type?: string;
};

type KlipyResponse = {
  data?: { data?: KlipyRawGif[] };
  result?: boolean;
};

export type KlipyGif = {
  id: number;
  original: Required<KlipyAsset>;
  preview: Required<KlipyAsset>;
  slug: string;
  title: string;
};

const CUSTOMER_ID_KEY = "buzz:klipy-customer-id:v1";

/** Composer scopes end in the viewer key; the prefix is the registered community. */
export function communityFromScope(scope: string): string | null {
  const match = /^(.*):[0-9a-f]{64}$/i.exec(scope);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === "https:" && url.origin === match[1]
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function completeAsset(
  asset: KlipyAsset | undefined,
): asset is Required<KlipyAsset> {
  if (
    typeof asset?.url !== "string" ||
    typeof asset.width !== "number" ||
    typeof asset.height !== "number" ||
    typeof asset.size !== "number" ||
    !Number.isFinite(asset.width) ||
    !Number.isFinite(asset.height) ||
    !Number.isFinite(asset.size) ||
    asset.width <= 0 ||
    asset.height <= 0 ||
    asset.size <= 0
  )
    return false;
  try {
    return new URL(asset.url).protocol === "https:";
  } catch {
    return false;
  }
}

function firstAsset(...assets: Array<KlipyAsset | undefined>) {
  return assets.find(completeAsset) ?? null;
}

export function normalizeKlipyGifs(items: KlipyRawGif[]): KlipyGif[] {
  const gifs: KlipyGif[] = [];
  for (const item of items) {
    if (item.type !== "gif" || !item.file || !item.slug) continue;
    const original = firstAsset(
      item.file.md?.gif,
      item.file.hd?.gif,
      item.file.sm?.gif,
      item.file.xs?.gif,
    );
    const preview = firstAsset(
      item.file.sm?.webp,
      item.file.sm?.gif,
      item.file.xs?.webp,
      item.file.xs?.gif,
      original ?? undefined,
    );
    if (!original || !preview) continue;
    gifs.push({
      id: item.id ?? gifs.length,
      original,
      preview,
      slug: item.slug,
      title: item.title?.trim() || "GIF",
    });
  }
  return gifs;
}

function customerId() {
  try {
    const existing = localStorage.getItem(CUSTOMER_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(CUSTOMER_ID_KEY, created);
    return created;
  } catch {
    return "buzz-desktop";
  }
}

async function brokerRequest<T>(
  community: string,
  route: string,
  body: unknown | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const response = nativeIdentityEnabled()
    ? await nativeRelayRequest(community, route, body, signal)
    : await fetch(`/api/relay/${encodeURIComponent(community)}/${route}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        ...(signal ? { signal } : {}),
      });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    const message = result.error ?? `GIF request failed (${response.status})`;
    throw transientStatus(response.status)
      ? new ReadError("unavailable", message, response.status)
      : new Error(message);
  }
  return result;
}

/** Packaged builds have no broker to remember GIF discovery, so every search
 * would first re-read NIP-11. Keep the broker's per-relay cache here: only the
 * supported route is retained, because a relay can enable GIFs while the app
 * is running. Failed discovery or search is forgotten so capability changes
 * can be rediscovered on the next request. */
const nativeSearchPaths = new Map<string, Promise<string | null>>();
async function nativeSearchPath(community: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let discovery = nativeSearchPaths.get(community);
  if (!discovery) {
    // Shared by every caller, so no single caller's signal may cancel it.
    discovery = nativeRelayInfo(community).then(relayKlipySearchPath);
    nativeSearchPaths.set(community, discovery);
    const forget = () => nativeSearchPaths.delete(community);
    discovery.then((path) => {
      if (path !== "/gifs/search") forget();
    }, forget);
  }
  const path = await discovery;
  signal?.throwIfAborted();
  return path;
}

export async function relaySupportsKlipy(
  community: string,
  signal?: AbortSignal,
) {
  if (nativeIdentityEnabled())
    return (await nativeSearchPath(community, signal)) === "/gifs/search";
  const info = await brokerRequest<RelayGifSearchInfo>(
    community,
    "gif-info",
    undefined,
    signal,
  );
  return relayKlipySearchPath(info) !== null;
}

/** Search the provider through Buzz Relay; its API key never enters the app. */
export async function fetchKlipyGifs(
  community: string,
  query: string,
  signal?: AbortSignal,
): Promise<KlipyGif[]> {
  const route = nativeIdentityEnabled()
    ? await nativeSearchPath(community, signal)
    : "gifs";
  if (!route) throw new Error("GIF search is unavailable");
  if (nativeIdentityEnabled() && route !== "/gifs/search")
    throw new Error("GIF search is unavailable");
  try {
    const response = await retryRead(
      (signal) =>
        brokerRequest<KlipyResponse>(
          community,
          route,
          {
            customer_id: customerId(),
            locale: navigator.language || "en-US",
            query: query.trim(),
          },
          signal,
        ),
      signal ?? new AbortController().signal,
    );
    if (response.result === false) throw new Error("GIF search failed");
    return normalizeKlipyGifs(response.data?.data ?? []);
  } catch (error) {
    // A failed search may mean the relay disabled GIFs since discovery.
    // Caller cancellation says nothing about the shared capability.
    if (nativeIdentityEnabled() && !signal?.aborted)
      nativeSearchPaths.delete(community);
    throw error;
  }
}

/** Pickers can delegate relay access to their owning window. */
export type GifRequests = {
  supports: typeof relaySupportsKlipy;
  search: typeof fetchKlipyGifs;
};
export const relayGifRequests: GifRequests = {
  supports: relaySupportsKlipy,
  search: fetchKlipyGifs,
};

/** URL-only media keeps provider bytes and credentials out of Buzz storage. */
export function gifMarkdown(gif: KlipyGif) {
  const title = gif.title
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(/\s+/g, " ")
    .trim();
  const url = gif.original.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `![${title || "GIF"}](${url})`;
}
