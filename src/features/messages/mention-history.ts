import type { ComposerSession } from "./composer-session";

/** Session lifetime isolates community/viewer; bounded per-destination explicit choices. */
const histories = new WeakMap<
  ComposerSession,
  Map<string, Map<string, number>>
>();
export function mentionHistory(session: ComposerSession, channelId: string) {
  return histories.get(session)?.get(channelId);
}
export function rememberMention(
  session: ComposerSession,
  channelId: string,
  pubkey: string,
) {
  let destinations = histories.get(session);
  if (!destinations) {
    destinations = new Map();
    histories.set(session, destinations);
  }
  let history = destinations.get(channelId);
  if (!history) {
    history = new Map();
    destinations.set(channelId, history);
  }
  const next = Math.max(0, ...history.values()) + 1;
  history.delete(pubkey);
  history.set(pubkey, next);
  if (history.size > 100) history.delete(history.keys().next().value ?? "");
  if (destinations.size > 100)
    destinations.delete(destinations.keys().next().value ?? "");
}
