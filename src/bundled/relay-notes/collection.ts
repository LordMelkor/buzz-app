import type { ReadOptions } from "../../features/relay/reader";
import type { RelaySession } from "../../features/relay/session";
import type { EventData, ReadFilter } from "../../features/relay/events";

export const NOTE_LIMIT = 100;
export const noteTag = (event: EventData, tag: string) =>
  event.tags.find(([key]) => key === tag)?.[1] ?? "";
export const noteKey = (event: EventData) =>
  `30023:${event.pubkey}:${noteTag(event, "d")}`;
export const noteTitle = (event: EventData) =>
  noteTag(event, "title").trim() || noteTag(event, "d") || "Untitled note";

/** Retain one head per author/identifier, using NIP-01's timestamp/ID order. */
export function noteHeads(
  events: readonly EventData[],
  authors: readonly string[],
) {
  const allowed = new Set(authors);
  const heads = new Map<string, EventData>();
  for (const event of [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )) {
    if (event.kind !== 30023 || !allowed.has(event.pubkey)) continue;
    const key = noteKey(event);
    if (!heads.has(key)) heads.set(key, event);
  }
  return [...heads.values()];
}

export type NotePage = {
  notes: readonly EventData[];
  cursor?: { until: number; before_id: string } | undefined;
  done: boolean;
};
export const emptyNotePage = (): NotePage => ({ notes: [], done: false });

/** Page through the relay's newest-first timestamp/ID order without skipping ties. */
export async function readNotePage(
  session: Pick<RelaySession, "readPage">,
  filter: ReadFilter,
  previous: NotePage,
  options: ReadOptions,
): Promise<NotePage> {
  if (previous.done) return previous;
  const page = await session.readPage(
    [{ ...filter, ...previous.cursor }],
    options,
  );
  options.signal?.throwIfAborted();
  const events = page.events
    .filter(
      (event) =>
        !previous.cursor ||
        event.created_at < previous.cursor.until ||
        (event.created_at === previous.cursor.until &&
          event.id > previous.cursor.before_id),
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const last = events.at(-1);
  const done = page.relayCount < filter.limit;
  // A relay ignoring the cursor (or hiding a whole page) must not silently
  // skip a timestamp or claim the collection is complete.
  if (page.relayCount > 0 && !last)
    throw new Error("Notes page did not advance");
  const combined = [...previous.notes, ...events];
  return {
    notes: noteHeads(
      combined,
      combined.map((event) => event.pubkey),
    ),
    cursor: last
      ? { until: last.created_at, before_id: last.id }
      : previous.cursor,
    done,
  };
}
