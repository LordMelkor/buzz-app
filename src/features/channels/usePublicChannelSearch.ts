import { retryRead } from "../relay/read-retry";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { ComposerSession } from "../messages/composer-session";
import { searchDebounce, searchable } from "../../shared/search-debounce";

const none: readonly ChannelSummary[] = [];

type Result = {
  /** The lookup that produced this result: its session, query and attempt. */
  owner: { session: ComposerSession };
  channels: readonly ChannelSummary[];
  partial: boolean;
  /** Matches from the pages read so far; the directory read goes on. */
  pending?: boolean;
  error?: string;
};

/** Public channels the viewer has not joined, found by name for Command-K and
 * the composer's `#` completion. The store resolves each match, so opening one
 * reaches the read-only preview. */
export function usePublicChannelSearch(
  session: ComposerSession,
  query: string,
  ready: boolean,
  exact = false,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const search = session.channels.searchPublic;
  // An exact lookup names a whole channel, so it may be a single character.
  const active = (exact ? !!query : searchable(query)) && ready && !!search;
  const owner = useMemo(
    () => ({ session, query, exact, attempt }),
    [session, query, exact, attempt],
  );
  useEffect(() => {
    if (!active || !search) return;
    const controller = new AbortController();
    // The matches already shown while the directory read goes on.
    let shown = "";
    let kept = none;
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const cancel = searchDebounce(() => {
      retryRead(
        (signal) =>
          search(query, {
            signal,
            priority: "foreground",
            exact,
            // An exact lookup names one channel, so it waits for every page.
            progress: exact
              ? undefined
              : ({ channels }) => {
                  const ids = channels.map(({ id }) => id).join();
                  if (controller.signal.aborted || ids === shown) return;
                  shown = ids;
                  kept = channels;
                  setResult({ owner, channels, partial: false, pending: true });
                },
          }),
        controller.signal,
      ).then(
        ({ channels, partial }) => {
          if (!controller.signal.aborted)
            setResult({ owner, channels, partial });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              owner,
              // Matches already shown stay; only the rest of the read failed.
              channels: kept,
              partial: false,
              error: `Public channel search couldn’t finish${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}`,
            });
        },
      );
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [query, active, search, exact, owner]);
  const current = result?.owner === owner ? result : undefined;
  const loading = active && (!current || !!current.pending);
  // While the next lookup runs, keep the last answer's rows that still
  // match, so open channels don't vanish and return on every keystroke. The
  // store keeps that answer: the composer remounts this hook per edit.
  const match = session.channels.matchPublic;
  const found = useMemo(() => {
    if (current) return current.channels;
    if (!loading || !match) return none;
    const kept = match(query, { exact });
    return kept.length ? kept : none;
  }, [current, loading, match, query, exact]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    loading,
    // A channel joined or removed since the lookup leaves this result set.
    channels: found.filter(
      (channel) => session.channels.get?.(channel.id)?.readOnly,
    ),
    /** The lookup's channels, or the previous lookup's still-matching ones
     * while it runs: the same array until either changes. Callers that keep
     * it must recheck each channel themselves. */
    found,
    partial: !!current?.partial,
    error: current?.error,
    retry,
  };
}
