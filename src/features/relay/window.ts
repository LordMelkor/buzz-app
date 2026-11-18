import { CHANNEL_ROW_KINDS } from "./membership";
import { isObject, objectBody } from "./body";
import { hasTag, type ReadFilter, type RelayEvent } from "./events";
import { relayOrder, type ThreadCursor } from "./thread-window";

export type WindowCursor = Readonly<{ createdAt: number; eventId: string }>;
export type WindowPage = Readonly<{
  events: RelayEvent[];
  cursor: WindowCursor | null;
  hasMore: boolean;
}>;
export const WINDOW_PAGE_SIZE = 20;
/** Row kinds a window page reads. Membership notices (40099) are read apart by
 * `noticeFilter`: a page counts every row kind against its limit, so a burst
 * of joins would otherwise fill pages and hold the messages back. */
export const WINDOW_KINDS: readonly number[] = CHANNEL_ROW_KINDS.filter(
  (kind) => kind !== 40099,
);
export const NOTICE_PAGE_SIZE = 500;

/** NIP-CW window request: top-level rows plus aux closure and thread summaries, paged by the relay's composite cursor.
 * A bare (`full: false`) request reads rows only, for a seek's probes. */
export function windowFilter(
  channelId: string,
  cursor: WindowCursor | null,
  limit = WINDOW_PAGE_SIZE,
  full = true,
): ReadFilter {
  return {
    kinds: [...WINDOW_KINDS],
    "#h": [channelId],
    limit: Math.max(1, Math.min(200, limit)),
    top_level: true,
    ...(full ? { include_aux: true, include_summaries: true } : {}),
    ...(cursor ? { until: cursor.createdAt, before_id: cursor.eventId } : {}),
  };
}
/** The relay's membership notices in a channel, newest first, below `cursor`
 * by the same composite keyset the window pages use. */
export function noticeFilter(
  channelId: string,
  relayAuthor: string,
  cursor: WindowCursor | null,
): ReadFilter {
  return {
    kinds: [40099],
    "#h": [channelId],
    authors: [relayAuthor],
    limit: NOTICE_PAGE_SIZE,
    ...(cursor ? { until: cursor.createdAt, before_id: cursor.eventId } : {}),
  };
}
/** The relay answers each served window with exactly one signed kind 39006 bounds event. Anything else is rejected;
 * an absent or malformed bound must never be mistaken for "no more history".
 * A `newer` page (oldest first) has its own `:newer:` lane and direction. */
export function parseWindow(
  channelId: string,
  cursor: WindowCursor | null,
  relayAuthor: string,
  events: readonly RelayEvent[],
  newer = false,
): WindowPage {
  const lane = newer ? `${channelId}:newer` : channelId;
  const suffix = cursor
    ? `${lane}:${cursor.createdAt}:${cursor.eventId}`
    : `${lane}:head`;
  const bounds = events.filter(
    (event) =>
      event.kind === 39006 &&
      event.pubkey === relayAuthor &&
      hasTag(event, "h", channelId) &&
      hasTag(event, "d", suffix),
  );
  const [bound] = bounds;
  if (bounds.length !== 1 || !bound)
    throw new Error("Channel history response has invalid window bounds");
  const body = objectBody(bound.content);
  if (!body || body.direction !== (newer ? "newer" : undefined))
    throw new Error("Channel history bounds are malformed");
  if (typeof body.has_more !== "boolean")
    throw new Error("Channel history bounds omit has_more");
  const next = body.next_cursor;
  let nextCursor: WindowCursor | null = null;
  if (next != null) {
    if (
      !isObject(next) ||
      typeof next.created_at !== "number" ||
      !Number.isSafeInteger(next.created_at) ||
      next.created_at < 0 ||
      typeof next.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(next.id)
    )
      throw new Error("Channel history cursor is malformed");
    nextCursor = { createdAt: next.created_at, eventId: next.id };
    // History order is descending timestamp, then ascending id; forward
    // pages run the reverse. Equal-time pages must move on by id; a repeated
    // cursor is not progress.
    const from = cursor && { created_at: cursor.createdAt, id: cursor.eventId };
    if (from && relayOrder(next as ThreadCursor, from) * (newer ? 1 : -1) <= 0)
      throw new Error("Channel history cursor does not advance");
  }
  if (body.has_more !== (nextCursor !== null))
    throw new Error("Channel history bounds contradict their cursor");
  return {
    events: events.filter((event) => event.kind !== 39006),
    hasMore: body.has_more,
    cursor: nextCursor,
  };
}

/** Runs on signature-verified finite results BEFORE session admission: each
 * `top_level` filter names one channel and is answered by exactly one valid
 * bound of its own lane and cursor, and no other 39006 rides along. A bound
 * binds only channel, lane and cursor, so two such filters for the same ones
 * cannot be told apart and are rejected. */
export function verifyChannelWindows(
  filters: readonly ReadFilter[],
  events: readonly RelayEvent[],
  relayAuthor: string,
) {
  const windows = filters.filter((filter) => filter.top_level === true);
  if (!windows.length) return;
  const invalid = () =>
    new Error("Channel history response has invalid window bounds");
  for (const filter of windows) {
    const [channelId, ...extra] = filter["#h"] ?? [];
    if (!channelId || extra.length) throw invalid();
    const newer = filter.direction === "newer";
    const [at, id] = newer
      ? [filter.after, filter.after_id]
      : [filter.until, filter.before_id];
    parseWindow(
      channelId,
      at === undefined ? null : { createdAt: at, eventId: id ?? "" },
      relayAuthor,
      events,
      newer,
    );
  }
  if (events.filter((event) => event.kind === 39006).length !== windows.length)
    throw invalid();
}
