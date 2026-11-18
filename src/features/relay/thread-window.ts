import type { ReadFilter, RelayEvent } from "./events";
import { ReadError } from "./errors";
import { isObject, objectBody } from "./body";

export type ThreadCursor = Readonly<{ created_at: number; id: string }>;
export class MissingThreadBounds extends ReadError {
  constructor(readonly legacyRows = false) {
    super("invalid-response", "Relay did not serve a signed thread window");
  }
}
const invalid = () =>
  new ReadError("invalid-response", "Thread window bounds are invalid");
const hex = /^[0-9a-f]{64}$/;
export const canonicalChannel = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Same authority normalization as buzz-core::tenant::normalize_host. Never use the local broker host. */
export function threadAuthority(origin: string) {
  const url = new URL(origin);
  if (
    !["https:", "http:", "wss:", "ws:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw invalid();
  return url.host
    .toLowerCase()
    .replace(/:(80|443)$/, "")
    .replace(/\.$/, "");
}

const requestCursor = (filter: ReadFilter) =>
  filter.direction === "newer"
    ? filter.after === undefined
      ? undefined
      : { created_at: filter.after, id: filter.after_id ?? "" }
    : filter.until === undefined
      ? undefined
      : { created_at: filter.until, id: filter.before_id ?? "" };

/** NIP-CW thread-mode v1, identical to buzz-core::thread_window::Request::binding.
 * Default options keep the original array, so older bindings are unchanged. */
export async function threadBinding(
  filter: ReadFilter,
  origin: string,
  viewer: string,
) {
  const cursor = requestCursor(filter);
  const canonical = JSON.stringify([
    "tw",
    1,
    filter.direction ?? "older",
    threadAuthority(origin),
    viewer,
    filter["#h"]?.[0],
    filter["#e"]?.[0],
    filter.limit,
    filter.depth_limit ?? 100,
    [...new Set(filter.kinds)].sort((a, b) => a - b),
    cursor ? [cursor.created_at, cursor.id] : null,
    filter.include_aux ?? false,
    ...(filter.root_aux === false ? ["root_aux:false"] : []),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return (
    "tw:1:" +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Relay window order, oldest first: `created_at ASC, id DESC`. Older pages
 * run its exact reverse. */
export function relayOrder(a: ThreadCursor, b: ThreadCursor) {
  return (
    a.created_at - b.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

export function threadBounds(
  event: RelayEvent,
  direction: "older" | "newer" = "older",
): {
  hasMore: boolean;
  cursor: ThreadCursor | null;
} {
  const body = objectBody(event.content);
  if (
    body?.version !== 1 ||
    body.direction !== direction ||
    typeof body.has_more !== "boolean"
  )
    throw invalid();
  const next = body.next_cursor;
  if (
    next !== null &&
    (!isObject(next) ||
      !Number.isSafeInteger(next.created_at) ||
      typeof next.created_at !== "number" ||
      next.created_at < 0 ||
      // chrono 0.4's DateTime::MAX_UTC, used by the relay's Cursor::timestamp.
      next.created_at > 8_210_266_876_799 ||
      typeof next.id !== "string" ||
      !hex.test(next.id))
  )
    throw invalid();
  if (body.has_more !== (next !== null)) throw invalid();
  return { hasMore: body.has_more, cursor: next as ThreadCursor | null };
}

/** Runs on signature-verified finite results BEFORE session admission. Missing bounds
 * are distinct from invalid bounds; only the first probe may choose a clean legacy restart. */
export async function verifyThreadWindows(
  filters: readonly ReadFilter[],
  events: readonly RelayEvent[],
  origin: string | undefined,
  viewer: string,
  relayAuthor: string,
) {
  if (!filters.some((filter) => filter.thread_window === true)) return;
  if (
    !origin ||
    !hex.test(viewer) ||
    !hex.test(relayAuthor) ||
    filters.some((filter) => !filter.thread_window)
  )
    throw invalid();
  const bounds = events.filter((event) => event.kind === 39007);
  if (!bounds.length)
    throw new MissingThreadBounds(
      events.some((event) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(event.kind) &&
            event.tags.some(
              ([key, value]) => key === "h" && value === filter["#h"]?.[0],
            ) &&
            event.tags.some(
              ([key, value]) => key === "e" && value === filter["#e"]?.[0],
            ),
        ),
      ),
    );
  if (bounds.length !== filters.length) throw invalid();
  const remaining = new Set(bounds);
  for (const filter of filters) {
    const binding = await threadBinding(filter, origin, viewer);
    const bound = bounds.find((event) =>
      event.tags.some(([key, value]) => key === "d" && value === binding),
    );
    if (
      !bound ||
      !remaining.delete(bound) ||
      bound.pubkey !== relayAuthor ||
      bound.tags.length !== 3 ||
      ![
        ["d", binding],
        ["h", filter["#h"]?.[0]],
        ["e", filter["#e"]?.[0]],
      ].every(
        ([key, value]) =>
          bound.tags.filter(
            (tag) => tag.length === 2 && tag[0] === key && tag[1] === value,
          ).length === 1,
      )
    )
      throw invalid();
    const newer = filter.direction === "newer";
    const { cursor } = threadBounds(bound, newer ? "newer" : "older");
    const from = requestCursor(filter);
    if (cursor && from && relayOrder(cursor, from) * (newer ? 1 : -1) <= 0)
      throw invalid();
  }
}
