import type { Profile } from "./contracts";
import type { ProfileQueries } from "./profile-directory";
/** Narrow external-store projection. The source may notify broadly; downstream
 * observers are notified only when one of their referenced profile values changes.
 * A replacement selection may start from its predecessor's snapshot, keeping
 * that identity while the selected values are unchanged. */
export function selectProfiles(
  queries: ProfileQueries,
  ids: readonly string[],
  previous: ReadonlyMap<string, Profile> = new Map(),
) {
  let snapshot = previous;
  const read = () => {
    const all = queries.snapshot();
    const next = new Map<string, Profile>();
    for (const id of ids) {
      const value = all.get(id);
      if (value) next.set(id, value);
    }
    if (
      next.size !== snapshot.size ||
      [...next].some(([id, value]) => snapshot.get(id) !== value)
    )
      snapshot = next;
    return snapshot;
  };
  return {
    snapshot: read,
    subscribe(listener: () => void) {
      return queries.subscribe(() => {
        const old = snapshot;
        read();
        if (snapshot !== old) listener();
      });
    },
  };
}
