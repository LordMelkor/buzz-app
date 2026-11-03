import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { PEOPLE_SEARCH_MAX_LENGTH } from "../../features/relay/direct-messages";
import { PROFILE_CACHE_BASE } from "../../features/relay/budget";
import type {
  VerifiedProfile,
  VerifiedProfileAuthority,
} from "../../features/relay/verified-profile";
import { searchDebounce, searchable } from "../../shared/search-debounce";

type Person = Awaited<
  ReturnType<RelaySession["directMessages"]["people"]>
>["people"][number];
const none: readonly Person[] = [];
const unverified: ReadonlyMap<string, VerifiedProfile> = new Map();
/** People remembered as looked up while the search is open: the shared
 * profile cache's base budget. */
const LOOKED_UP_LIMIT = PROFILE_CACHE_BASE;

/**
 * The first page of the community directory for typed text. Command-K shows a
 * few rows per group, so it reads one page per query, unlike New message,
 * which pages through every match. While a new query loads, the last page
 * stays available so its still-matching people do not blink out. Text longer
 * than the directory accepts reads nothing, so a pasted message-search phrase
 * does not show a people error.
 *
 * Once a page settles, the community's verified names for its people who are
 * not already verified in the shared profiles load in the background, under
 * the same cancellation. The rows show first and update once. People already
 * looked up while the search is open are not asked about again, so refining a
 * query reads only its new rows. Names belong to the authority that checked
 * them: when the community changes or withdraws it, they are dropped and the
 * page is read again.
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
    verified: ReadonlyMap<string, VerifiedProfile>;
    verifiedBy: VerifiedProfileAuthority | undefined;
    error?: true;
  }>();
  const authority = useSyncExternalStore(session.profiles.subscribe, () =>
    session.profiles.verifiedAuthority?.(),
  );
  const lookups = useRef<{
    session: RelaySession;
    authority: VerifiedProfileAuthority;
    found: Map<string, VerifiedProfile | undefined>;
  }>(undefined);
  const active =
    enabled && searchable(query) && query.length <= PEOPLE_SEARCH_MAX_LENGTH;
  useEffect(() => {
    if (!active) return;
    if (
      authority &&
      (lookups.current?.session !== session ||
        lookups.current.authority !== authority)
    )
      lookups.current = { session, authority, found: new Map() };
    const found = authority && lookups.current?.found;
    const controller = new AbortController();
    const cancel = searchDebounce(() => {
      session.directMessages.people(query, 1, controller.signal).then(
        ({ people }) => {
          if (controller.signal.aborted) return;
          // Names verified for earlier pages stay for their people.
          setState((previous) => ({
            query,
            attempt,
            people,
            verified: previous?.verified ?? unverified,
            verifiedBy: previous?.verifiedBy,
          }));
          if (!found) return;
          const shared = session.profiles.snapshot();
          const wanted = people
            .filter(
              ({ pubkey, isAgent }) =>
                !isAgent && !found.has(pubkey) && !shared.get(pubkey)?.verified,
            )
            .map(({ pubkey }) => pubkey);
          if (!wanted.length) return;
          session.directMessages.verified(wanted, controller.signal).then(
            (verified) => {
              // Nothing was checked, or not by this authority: ask again later.
              if (
                controller.signal.aborted ||
                verified?.authority !== authority
              )
                return;
              for (const pubkey of wanted) {
                found.delete(pubkey);
                found.set(pubkey, verified.profiles.get(pubkey));
              }
              for (const pubkey of found.keys()) {
                if (found.size <= LOOKED_UP_LIMIT) break;
                found.delete(pubkey);
              }
              const known = new Map<string, VerifiedProfile>();
              for (const [pubkey, profile] of found)
                if (profile) known.set(pubkey, profile);
              setState(
                (previous) =>
                  previous && {
                    ...previous,
                    verified: known,
                    verifiedBy: authority,
                  },
              );
            },
            // Without verified names the page keeps its profile names.
            () => {},
          );
        },
        () => {
          if (!controller.signal.aborted)
            setState((previous) => ({
              query,
              attempt,
              people: previous?.people ?? none,
              verified: previous?.verified ?? unverified,
              verifiedBy: previous?.verifiedBy,
              error: true,
            }));
        },
      );
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [session, query, active, attempt, authority]);
  const current = state?.query === query && state.attempt === attempt;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    people: active ? (state?.people ?? none) : none,
    verified:
      active && authority && state?.verifiedBy === authority
        ? state.verified
        : unverified,
    loading: active && !current,
    error: active && current && !!state?.error,
    retry,
  };
}
