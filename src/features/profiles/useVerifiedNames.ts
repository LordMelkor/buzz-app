import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PROFILE_CACHE_BASE } from "../relay/budget";
import type { ProfileQueries } from "../relay/profile-directory";
import {
  type NamePreference,
  namePreference,
  verifiedLabel,
} from "./name-preference";
import type { RelaySession } from "../relay/session";
import type {
  VerifiedProfile,
  VerifiedProfileAuthority,
} from "../relay/verified-profile";

/** The session parts a people search needs to name its rows. A session that
 * cannot read verified names (a composer bridge) still gets shared ones. */
export type VerifiedNamesSession = {
  profiles: ProfileQueries;
  directMessages: Partial<
    Pick<RelaySession["directMessages"], "verified" | "searched">
  >;
};
type Found = Map<string, { profile: VerifiedProfile | undefined; at: number }>;

/** Subjects per read: one people page. */
const BATCH = 30;
/** How long a lookup answers before it is asked again, as the shared
 * directory refreshes discovery. */
const FRESH_MS = 5 * 60_000;
const none: ReadonlyMap<string, VerifiedProfile> = new Map();
// People looked up per session and authority, so a picker that remounts on
// each keystroke does not ask again. Bounded like the shared profile cache and
// re-asked after FRESH_MS; another authority, or the same key re-enabled,
// starts over.
const lookups = new WeakMap<
  ProfileQueries,
  { authority: VerifiedProfileAuthority; found: Found; stop: () => void }
>();
function foundFor(
  profiles: ProfileQueries,
  authority: VerifiedProfileAuthority,
) {
  const current = lookups.get(profiles);
  if (current?.authority === authority) return current.found;
  current?.stop();
  const found: Found = new Map();
  // A shared head supersedes a search's answer for good, mounted or not, so
  // the answer cannot return once the shared cache evicts that head.
  let seen = profiles.verifiedRevision?.() ?? 0;
  const stop = profiles.subscribe(() => {
    const since = seen;
    seen = profiles.verifiedRevision?.() ?? 0;
    if (seen === since) return;
    for (const pubkey of found.keys())
      if (superseded(profiles, pubkey, since)) found.delete(pubkey);
  });
  lookups.set(profiles, { authority, found, stop });
  return found;
}
/** Whether a shared head outranks a search's answer from `revision`: one is
 * held now, or a later one arrived, even if the shared cache evicted it. */
export function superseded(
  profiles: ProfileQueries,
  pubkey: string,
  revision: number,
) {
  return (
    !!profiles.verifiedHeld?.(pubkey) ||
    !!profiles.verifiedSince?.(pubkey, revision)
  );
}

/** What one `lookUpVerified` pass knows: each person's verified name, or its
 * absence, by the authority that checked it and the shared heads' revision
 * it was asked at. */
export type VerifiedAnswers = {
  authority: VerifiedProfileAuthority;
  answers: ReadonlyMap<
    string,
    { profile: VerifiedProfile | undefined; asked: number }
  >;
};

/**
 * Reads the verified names of `pubkeys` that neither the shared profiles nor
 * fresh lookups hold, `batch` at a time and one read after another, so a
 * waiting read does not spend its deadline in the reader's queue. Answers go
 * into the lookups `verifiedName` reads and are returned too, so a pass
 * longer than the lookups hold keeps all of its own. A failed read, or one
 * by another authority, ends the pass; the rest keep their profile names.
 * At most `limit` people are asked. `asked` is the shared heads' revision
 * the caller's search began at, when it began before this pass: a head that
 * arrived since outranks this pass's answers, even those the search found.
 */
export async function lookUpVerified(
  session: VerifiedNamesSession,
  pubkeys: readonly string[],
  signal: AbortSignal,
  {
    batch = BATCH,
    limit = Infinity,
    asked: since = Infinity,
    onStart,
    onPage,
  }: {
    batch?: number;
    limit?: number;
    asked?: number;
    onStart?: () => void;
    onPage?: () => void;
  } = {},
): Promise<VerifiedAnswers | undefined> {
  const { profiles } = session;
  const read = session.directMessages?.verified;
  const searched = session.directMessages?.searched;
  const authority = profiles.verifiedAuthority?.();
  if (!authority || !read) return undefined;
  const found = foundFor(profiles, authority);
  const known = profiles.snapshot();
  const now = Date.now();
  const revision = Math.min(since, profiles.verifiedRevision?.() ?? 0);
  const answers = new Map<
    string,
    { profile: VerifiedProfile | undefined; asked: number }
  >();
  // Each person is asked once a pass, and eviction during it asks nobody
  // again. A search that answered for someone since their lookup outdates it.
  const queue: string[] = [];
  for (const pubkey of new Set(pubkeys)) {
    if (known.get(pubkey)?.verified || profiles.verifiedHeld?.(pubkey))
      continue;
    const held = found.get(pubkey);
    if (held && now - held.at < FRESH_MS && !searched?.(pubkey, authority))
      answers.set(pubkey, { profile: held.profile, asked: revision });
    else if (queue.length < limit) queue.push(pubkey);
  }
  if (queue.length) onStart?.();
  for (let start = 0; start < queue.length; start += batch) {
    const wanted = queue.slice(start, start + batch);
    const asked = Math.min(since, profiles.verifiedRevision?.() ?? 0);
    // A failed read checked nothing, like a changed authority.
    const result = await read(wanted, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (result?.authority !== authority) break;
    const at = Date.now();
    for (const pubkey of wanted) {
      const profile = result.profiles.get(pubkey);
      answers.set(pubkey, { profile, asked });
      found.delete(pubkey);
      // A shared head that arrived during the read answers instead.
      if (!superseded(profiles, pubkey, asked))
        found.set(pubkey, { profile, at });
    }
    for (const pubkey of found.keys()) {
      if (found.size <= PROFILE_CACHE_BASE) break;
      found.delete(pubkey);
    }
    onPage?.();
  }
  return { authority, answers };
}

/** `pubkey`'s verified name in a pass's `answers`, while their authority
 * holds and no shared head has answered for the person since. */
export function answeredName(
  profiles: ProfileQueries,
  verified: VerifiedAnswers | undefined,
  pubkey: string,
) {
  const answer = verified?.answers.get(pubkey);
  return answer &&
    verified?.authority === profiles.verifiedAuthority?.() &&
    !superseded(profiles, pubkey, answer.asked)
    ? answer.profile
    : undefined;
}

/**
 * Community-verified names for people a search found that the shared profiles
 * have not verified. While `settled`, the unasked ones are read in the
 * background, a page at a time. One pass asks at most as many as the cache
 * holds (PROFILE_CACHE_BASE); the rest of a longer list keep their profile
 * names until a later pass. A changed `key` (the typed query) or list cancels
 * the read, and an unsettled list starts none. Names belong to the authority
 * that checked them: when the community withdraws or changes it, none are
 * returned until they are checked again.
 */
export function useVerifiedNames(
  session: VerifiedNamesSession,
  people: readonly { pubkey: string; isAgent?: boolean | undefined }[],
  { key = "", settled = true }: { key?: string; settled?: boolean } = {},
): ReadonlyMap<string, VerifiedProfile> {
  const { profiles } = session;
  const read = session.directMessages?.verified;
  const searched = session.directMessages?.searched;
  const authority = useSyncExternalStore(profiles.subscribe, () =>
    profiles.verifiedAuthority?.(),
  );
  // A shared head that arrives later outranks a search's answer, even one that
  // leaves the shared profiles as they were.
  const heads = useSyncExternalStore(
    profiles.subscribe,
    () => profiles.verifiedRevision?.() ?? 0,
  );
  const [revision, setRevision] = useState(0);
  const subjects = people
    .flatMap(({ pubkey, isAgent }) => (isAgent ? [] : [pubkey]))
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed key cancels the read.
  useEffect(() => {
    if (!settled || !authority || !read || !subjects) return;
    const controller = new AbortController();
    void lookUpVerified(session, subjects.split(","), controller.signal, {
      limit: PROFILE_CACHE_BASE,
      onPage: () => setRevision((value) => value + 1),
    }).catch(() => {});
    return () => controller.abort();
  }, [profiles, read, searched, authority, subjects, settled, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a landed read moves the revision.
  return useMemo(() => {
    const current = authority && lookups.get(profiles);
    if (!current || current.authority !== authority || !subjects) return none;
    const named = new Map<string, VerifiedProfile>();
    for (const pubkey of subjects.split(",")) {
      const profile = current.found.get(pubkey)?.profile;
      if (profile && !profiles.verifiedHeld?.(pubkey))
        named.set(pubkey, profile);
    }
    return named.size ? named : none;
  }, [profiles, authority, subjects, revision, heads]);
}

/** A person's verified name as these lookups or the shared profiles hold it
 * now, for matching a page a hook has already named. */
export function verifiedName(profiles: ProfileQueries, pubkey: string) {
  const shared = profiles.snapshot().get(pubkey)?.verified;
  if (shared || profiles.verifiedHeld?.(pubkey)) return shared;
  const authority = profiles.verifiedAuthority?.();
  const current = authority && lookups.get(profiles);
  return current && current.authority === authority
    ? current.found.get(pubkey)?.profile
    : undefined;
}

/**
 * `pubkey`'s verified name by the latest answer any read gave, "not verified"
 * included: the lookups keep it, since every pass writes there and a failed
 * read writes nothing. Once they evict the person, the latest of `passes`
 * that answered for them speaks. Either holds only while its authority does
 * and no shared head has answered for the person since.
 */
export function latestName(
  profiles: ProfileQueries,
  passes: readonly (VerifiedAnswers | undefined)[],
  pubkey: string,
) {
  const authority = profiles.verifiedAuthority?.();
  const current = authority && lookups.get(profiles);
  const latest =
    current && current.authority === authority
      ? current.found.get(pubkey)
      : undefined;
  if (latest)
    return profiles.verifiedHeld?.(pubkey) ? undefined : latest.profile;
  const pass = passes.filter((read) => read?.answers.has(pubkey)).at(-1);
  return answeredName(profiles, pass, pubkey);
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
  preference: NamePreference = namePreference(),
): readonly VerifiedPerson<T>[] {
  let changed = false;
  const named = people.map((person): VerifiedPerson<T> => {
    const verified =
      shared.get(person.pubkey)?.verified ?? page.get(person.pubkey);
    if (!verified) return person;
    changed = true;
    return {
      ...person,
      name: verifiedLabel(verified, preference),
      username: verified.username,
      ...(verified.fullName ? { fullName: verified.fullName } : {}),
      profileNames: [person.name, person.username].filter(
        (name): name is string => !!name,
      ),
    };
  });
  return changed ? named : people;
}
