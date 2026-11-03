import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PROFILE_CACHE_BASE } from "../relay/budget";
import type { ProfileQueries } from "../relay/profile-directory";
import type { RelaySession } from "../relay/session";
import type {
  VerifiedProfile,
  VerifiedProfileAuthority,
} from "../relay/verified-profile";

/** The session parts a people search needs to name its rows. A session that
 * cannot read verified names (a composer bridge) still gets shared ones. */
export type VerifiedNamesSession = {
  profiles: ProfileQueries;
  directMessages: Partial<Pick<RelaySession["directMessages"], "verified">>;
};
type Found = Map<string, VerifiedProfile | undefined>;

/** Subjects per read: one people page. */
const BATCH = 30;
const none: ReadonlyMap<string, VerifiedProfile> = new Map();
// People looked up per session and authority, so a picker that remounts on
// each keystroke does not ask again. Bounded like the shared profile cache;
// another authority, or the same key re-enabled, starts over.
const lookups = new WeakMap<
  ProfileQueries,
  { authority: VerifiedProfileAuthority; found: Found }
>();
function foundFor(
  profiles: ProfileQueries,
  authority: VerifiedProfileAuthority,
) {
  const current = lookups.get(profiles);
  if (current?.authority === authority) return current.found;
  const found: Found = new Map();
  lookups.set(profiles, { authority, found });
  return found;
}

/**
 * Community-verified names for people a search found that the shared profiles
 * have not verified. Once `people` settles, the unasked ones are read in the
 * background, a page at a time, and cancelled when `people` changes. Names
 * belong to the authority that checked them: when the community withdraws or
 * changes it, none are returned until they are checked again.
 */
export function useVerifiedNames(
  session: VerifiedNamesSession,
  people: readonly { pubkey: string; isAgent?: boolean | undefined }[],
): ReadonlyMap<string, VerifiedProfile> {
  const { profiles } = session;
  const read = session.directMessages?.verified;
  const authority = useSyncExternalStore(profiles.subscribe, () =>
    profiles.verifiedAuthority?.(),
  );
  const [revision, setRevision] = useState(0);
  const subjects = people
    .flatMap(({ pubkey, isAgent }) => (isAgent ? [] : [pubkey]))
    .join(",");
  useEffect(() => {
    if (!authority || !read || !subjects) return;
    const found = foundFor(profiles, authority);
    const shared = profiles.snapshot();
    const wanted = subjects
      .split(",")
      .filter((pubkey) => !found.has(pubkey) && !shared.get(pubkey)?.verified)
      .slice(0, BATCH);
    if (!wanted.length) return;
    const controller = new AbortController();
    read(wanted, controller.signal).then(
      (result) => {
        // Nothing was checked, or not by this authority: ask again later.
        if (controller.signal.aborted || result?.authority !== authority)
          return;
        for (const pubkey of wanted) {
          found.delete(pubkey);
          found.set(pubkey, result.profiles.get(pubkey));
        }
        for (const pubkey of found.keys()) {
          if (found.size <= PROFILE_CACHE_BASE) break;
          found.delete(pubkey);
        }
        setRevision((value) => value + 1);
      },
      // Without verified names the rows keep their profile names.
      () => {},
    );
    return () => controller.abort();
  }, [profiles, read, authority, subjects]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a landed read moves the revision.
  return useMemo(() => {
    const current = authority && lookups.get(profiles);
    if (!current || current.authority !== authority || !subjects) return none;
    const named = new Map<string, VerifiedProfile>();
    for (const pubkey of subjects.split(",")) {
      const profile = current.found.get(pubkey);
      if (profile) named.set(pubkey, profile);
    }
    return named.size ? named : none;
  }, [profiles, authority, subjects, revision]);
}

/** A searched person as its community verified them, when it has. */
export type VerifiedPerson<T> = T & {
  /** The verified full name, shown beside the row's detail. */
  fullName?: string | undefined;
  /** The profile name and handle the search found them by, kept as match keys. */
  profileNames?: readonly string[] | undefined;
};

/**
 * `people` named by their verified names: the shared profiles' first, then
 * this search's. A person with neither is returned as is, and so is the
 * array when nobody changes.
 */
export function withVerifiedNames<
  T extends { pubkey: string; name: string; username?: string | undefined },
>(
  people: readonly T[],
  page: ReadonlyMap<string, VerifiedProfile>,
  shared: ReadonlyMap<string, { verified?: VerifiedProfile | undefined }>,
): readonly VerifiedPerson<T>[] {
  let changed = false;
  const named = people.map((person): VerifiedPerson<T> => {
    const verified =
      shared.get(person.pubkey)?.verified ?? page.get(person.pubkey);
    if (!verified) return person;
    changed = true;
    return {
      ...person,
      name: verified.displayName,
      username: verified.username,
      ...(verified.fullName ? { fullName: verified.fullName } : {}),
      profileNames: [person.name, person.username].filter(
        (name): name is string => !!name,
      ),
    };
  });
  return changed ? named : people;
}
