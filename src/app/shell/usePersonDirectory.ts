import { useCallback, useEffect, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { PEOPLE_SEARCH_MAX_LENGTH } from "../../features/relay/direct-messages";

type Person = Awaited<
  ReturnType<RelaySession["directMessages"]["people"]>
>["people"][number];
const none: readonly Person[] = [];

/** Typing pause before a Command-K people search reaches the relay. */
export const PERSON_DIRECTORY_DELAY_MS = 180;

/**
 * The first page of the community directory for typed text. Command-K shows a
 * few rows per group, so it reads one page per query, unlike New message,
 * which pages through every match. While a new query loads, the last page
 * stays available so its still-matching people do not blink out. Text longer
 * than the directory accepts reads nothing, so a pasted message-search phrase
 * does not show a people error.
 */
export function usePersonDirectory(
  session: RelaySession,
  query: string,
  enabled: boolean,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    query: string;
    attempt: number;
    people: readonly Person[];
    error?: true;
  }>();
  const active =
    enabled && !!query.trim() && query.length <= PEOPLE_SEARCH_MAX_LENGTH;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      session.directMessages.people(query, 1, controller.signal).then(
        ({ people }) => {
          if (!controller.signal.aborted) setState({ query, attempt, people });
        },
        () => {
          if (!controller.signal.aborted)
            setState((previous) => ({
              query,
              attempt,
              people: previous?.people ?? none,
              error: true,
            }));
        },
      );
    }, PERSON_DIRECTORY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, active, attempt]);
  const current = state?.query === query && state.attempt === attempt;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    people: active ? (state?.people ?? none) : none,
    loading: active && !current,
    error: active && current && !!state?.error,
    retry,
  };
}
