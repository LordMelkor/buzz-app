import { useProfileGeneration } from "../../features/relay/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { Profile } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { selectProfiles } from "../../features/relay/profile-selection";
import { IdentityRow } from "../../shared/identity/IdentityRow";
import {
  canonicalPublicKey,
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { useSession } from "./session";
import { shortKey } from "./ui";

/**
 * Profiles of the connected community. Staff often aren't members of the
 * community a row comes from, so a missing name falls back to the short key.
 */
export const ProfilesContext = createContext<ProfileQueries | null>(null);

const NONE: ReadonlyMap<string, Profile> = new Map();
const noop = () => () => {};

/**
 * The people one screen shows. Labels are computed over every key on the
 * screen so two people never look the same, and the screen fetches missing
 * profiles in one batch.
 */
export type People = {
  profile(pubkey: string): Profile | undefined;
  /** A real display name, or undefined. */
  name(pubkey: string): string | undefined;
  /** The screen-wide distinct short key. */
  label(pubkey: string): string;
  /** "Name (npub…xyz)", or the short key alone when no name is known. */
  text(pubkey: string): string;
};

/** Resolves names for every key a screen shows; pass the result to `PeopleScope`. */
export function usePeople(
  pubkeys: readonly (string | null | undefined)[],
): People {
  const profiles = useContext(ProfilesContext);
  const ids = [...new Set(pubkeys.filter((key): key is string => !!key))];
  const wanted = ids.join(",");
  // Only this screen's profiles: unrelated profile updates don't re-render it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined ids
  const selection = useMemo(
    () => (profiles ? selectProfiles(profiles, ids) : null),
    [profiles, wanted],
  );
  const snapshot = useSyncExternalStore(
    selection?.subscribe ?? noop,
    selection?.snapshot ?? (() => NONE),
  );
  const profileGeneration = useProfileGeneration(profiles ?? undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined ids
  useEffect(() => {
    if (profiles && ids.length)
      profiles.ensure(ids, "background").catch(() => {});
  }, [profiles, wanted, profileGeneration]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined ids
  const labels = useMemo(() => publicKeyLabels(ids), [wanted]);
  return useMemo(() => {
    const name = (pubkey: string) => {
      const value = snapshot.get(pubkey)?.name?.trim();
      // The profile source fills a nameless or malformed profile with the
      // key's hex prefix; that is not a name.
      return value && value !== pubkey.slice(0, 10) ? value : undefined;
    };
    const label = (pubkey: string) =>
      labels.get(pubkey.toLowerCase()) ?? shortKey(pubkey);
    return {
      profile: (pubkey) => snapshot.get(pubkey),
      name,
      label,
      text(pubkey) {
        const known = name(pubkey);
        return known ? `${known} (${label(pubkey)})` : label(pubkey);
      },
    };
  }, [snapshot, labels]);
}

const PeopleContext = createContext<People | null>(null);

/** Gives `Person` and `PersonName` below it the screen's names and labels. */
export function PeopleScope({
  people,
  children,
}: {
  people: People;
  children: React.ReactNode;
}) {
  return (
    <PeopleContext.Provider value={people}>{children}</PeopleContext.Provider>
  );
}

/** The enclosing screen's people, or a lookup of this one key outside any. */
function usePerson(pubkey: string) {
  const scoped = useContext(PeopleContext);
  const own = usePeople(scoped ? [] : [pubkey]);
  return scoped ?? own;
}

const fullKey = (pubkey: string) => canonicalPublicKey(pubkey) ?? pubkey;

/** Inline name for text that sits inside another control; full npub on hover. */
export function PersonName({
  pubkey,
  name: given,
  label: carried,
}: {
  pubkey: string;
  /** A name the caller already has, such as a member search result. */
  name?: string | null | undefined;
  /** The label this person had on the screen they were picked from. */
  label?: string | null | undefined;
}) {
  const people = usePerson(pubkey);
  const name = given || people.name(pubkey);
  const label = carried || people.label(pubkey);
  return (
    <span title={fullKey(pubkey)}>
      {name ? (
        <>
          {name} <span className="text-secondary">({label})</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** A person with avatar, short key and a preview that copies the full npub. */
export function Person({
  pubkey,
  detail,
}: {
  pubkey: string;
  detail?: string | undefined;
}) {
  const people = usePerson(pubkey);
  // An invalid key has no label and is never echoed.
  if (!formatPublicKey(pubkey)) return <>—</>;
  const found = people.profile(pubkey);
  const label = people.label(pubkey);
  return (
    <IdentityRow
      pubkey={pubkey}
      name={people.name(pubkey) ?? label}
      picture={found?.picture}
      isAgent={!!found?.isAgent}
      keyLabel={label}
      detail={detail}
    />
  );
}

/** Where names come from, so staff don't read them as the row's community's. */
export function NamesSource() {
  const { context } = useSession();
  let host = context.relay;
  try {
    host = new URL(context.relay).host;
  } catch {}
  return (
    <p className="text-caption text-secondary">
      Names come from profiles in {host}.
    </p>
  );
}
