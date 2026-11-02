import type { EventData } from "../relay/events";
import type { RelaySession } from "../relay/session";

export type HuddleRoom = Readonly<{
  id: string;
  creator: string;
  startedAt: number;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function room(event: EventData): string | undefined {
  try {
    const body: unknown = JSON.parse(event.content);
    if (!body || typeof body !== "object" || !("ephemeral_channel_id" in body))
      return;
    const id = body.ephemeral_channel_id;
    return typeof id === "string" && uuid.test(id) ? id : undefined;
  } catch {
    return;
  }
}
/** Discovery is advisory; the audio relay rechecks creator linkage and membership. */
export function recentHuddles(
  events: readonly EventData[],
  parent: string,
  authority: string | undefined,
  now = Date.now() / 1000,
): HuddleRoom[] {
  const scoped = events.filter((e) =>
    e.tags.some((t) => t[0] === "h" && t[1] === parent),
  );
  const starts = new Map<string, HuddleRoom>();
  for (const event of scoped) {
    const id = room(event);
    if (event.kind !== 48100 || !id || id === parent) continue;
    const previous = starts.get(id);
    // The initial creator's announcement owns this advisory room identity.
    if (!previous || event.created_at < previous.startedAt)
      starts.set(id, {
        id,
        creator: event.pubkey,
        startedAt: event.created_at,
      });
  }
  for (const event of scoped) {
    const id = room(event);
    const start = id ? starts.get(id) : undefined;
    if (
      event.kind === 48103 &&
      start &&
      event.created_at >= start.startedAt &&
      (event.pubkey === start.creator || event.pubkey === authority)
    )
      starts.delete(start.id);
  }
  return [...starts.values()]
    .filter((room) => room.startedAt <= now && room.startedAt + 3600 > now)
    .sort((a, b) => b.startedAt - a.startedAt);
}
export async function discoverHuddles(
  session: RelaySession,
  parent: string,
  signal: AbortSignal,
) {
  const events = await session.read(
    [
      { kinds: [48100], "#h": [parent], limit: 30 },
      { kinds: [48103], "#h": [parent], limit: 100 },
    ],
    { signal, priority: "foreground", fresh: true },
  );
  return recentHuddles(events, parent, session.relayAuthor);
}
