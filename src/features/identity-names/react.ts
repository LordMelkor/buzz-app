import type { NamingIdentity } from "./policy";
import { useSyncExternalStore, useCallback, useMemo } from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "./service";
const noSubscribe = () => () => {};
const watched = 500;
/** The interface arrives through the captured session, never a global lookup.
 * Pass stable `candidates` and `displayFacts` arrays: a new one re-renders on the next name change. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  // Re-render only when a label this component resolved changes: one arriving
  // profile should not repaint every name on screen.
  const labels = useMemo(() => watchLabels(names), [names]);
  const version = useSyncExternalStore(
    names?.subscribe ?? noSubscribe,
    labels.version,
    labels.version,
  );
  return useCallback(
    (
      pubkey: string,
      fallback: string,
      candidates?: readonly string[],
      displayFacts?: readonly NamingIdentity[],
    ): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void version;
      const label = names?.resolve(pubkey, fallback, candidates, displayFacts);
      labels.show(version, [pubkey, fallback, candidates, displayFacts], label);
      return label ?? fallback;
    },
    [names, labels, version],
  );
}

/** For callers that read `names.lookup` or `names.scope` directly, which
 * `useIdentityNames` does not watch: re-render on every name change while active. */
export function useNamesRevision(
  names: IdentityNameView | undefined,
  active: boolean,
) {
  return useSyncExternalStore(
    (active && names?.subscribe) || noSubscribe,
    () => names?.snapshot() ?? 0,
  );
}

/** The labels one consumer rendered at its current version. The version moves
 * when a name change would alter one of them, or they could not all be watched. */
function watchLabels(names: IdentityNameView | undefined) {
  type Args = Parameters<IdentityNameView["resolve"]>;
  const shown = new Map<string, { args: Args; label: string | undefined }>();
  let overflow = false;
  let version = 0;
  let recorded = 0;
  let seen = names?.snapshot();
  return {
    show(rendered: number, args: Args, label: string | undefined) {
      // The first label rendered at a newer version starts a new record; a
      // callback kept from an older render adds to the current one.
      if (rendered > recorded) {
        shown.clear();
        overflow = false;
        recorded = rendered;
      }
      if (!names || overflow) return;
      const [pubkey, fallback, candidates, displayFacts] = args;
      const key = `${pubkey}\n${fallback}`;
      const entry = shown.get(key);
      // One name in two scopes, such as after a member joins, would grow the
      // record with every new list: re-render on the next change instead.
      if (entry)
        overflow ||=
          entry.args[2] !== candidates || entry.args[3] !== displayFacts;
      else if (shown.size < watched) shown.set(key, { args, label });
      else overflow = true;
    },
    version() {
      const revision = names?.snapshot();
      if (revision === seen) return version;
      seen = revision;
      if (
        overflow ||
        [...shown.values()].some(
          ({ args, label }) => names?.resolve(...args) !== label,
        )
      )
        version++;
      return version;
    },
  };
}

const noMembers: readonly string[] = [];
/** Channel membership defines ambiguity, not the community-wide profile cache. */
export function useChannelIdentityNames(
  session:
    | {
        names?: IdentityNameView | undefined;
        channels: Pick<RelaySession["channels"], "list" | "subscribeList">;
      }
    | undefined,
  channelId: string | undefined,
) {
  const members = useListedChannel(
    session?.channels,
    channelId,
    (channel) => channel?.members ?? noMembers,
  );
  const resolve = useIdentityNames(session?.names);
  return useCallback(
    (pubkey: string, fallback: string) => resolve(pubkey, fallback, members),
    [resolve, members],
  );
}
