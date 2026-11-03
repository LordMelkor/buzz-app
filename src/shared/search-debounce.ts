import { useEffect, useState } from "react";

/** How long typing must pause before a search reaches the relay. */
export const SEARCH_DEBOUNCE_MS = 300;
/** The shortest typed text sent to the relay as a search. */
export const SEARCH_MIN_CHARS = 2;

/** Whether typed `text` is long enough to search the relay. */
export function searchable(text: string) {
  return text.trim().length >= SEARCH_MIN_CHARS;
}

/** The shortest last word a message search sends to the relay. The relay
 * matches that word as a prefix and ranks every match, so it answers a
 * shorter one with no hits rather than rank most of the community. */
export const MESSAGE_SEARCH_MIN_CHARS = 3;

/** Whether the last word of typed `text` is long enough to search messages. */
export function messageSearchable(text: string) {
  const last = text.trim().split(/\s+/).at(-1) ?? "";
  return [...last].length >= MESSAGE_SEARCH_MIN_CHARS;
}

/** Runs `search` once typing pauses. Call the returned cleanup from the
 * effect that owns the search, alongside aborting its request. */
export function searchDebounce(search: () => void, ms = SEARCH_DEBOUNCE_MS) {
  const timer = setTimeout(search, ms);
  return () => clearTimeout(timer);
}

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS) {
  const [settled, setSettled] = useState(value);
  useEffect(() => searchDebounce(() => setSettled(value), ms), [value, ms]);
  return settled;
}
