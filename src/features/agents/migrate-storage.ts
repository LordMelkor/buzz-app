// TEMPORARY agents rename: remove this module and its startup call after
// 2026-10-18, once the development users have upgraded. No runtime aliases.
import type { AgentStore } from "./store";
import { STORAGE_KEY, TEAMS_KEY } from "./store";

/** Copies each old key into memory at once, so reads that follow see it;
 * the promise settles once the copies are saved and their sources removed. */
export function migrateAgentStorage(storage: AgentStore) {
  const moves: Promise<void>[] = [];
  for (const [oldKey, key] of [
    ["buzz.agents2.v1", STORAGE_KEY],
    ["buzz.agents2.teams.v1", TEAMS_KEY],
  ] as const) {
    const old = storage.get(oldKey);
    if (old === null) continue;
    const current = storage.get(key);
    // An interrupted copy can resume; conflicting data needs recovery, never
    // an implicit overwrite or merge of independently edited settings. Either
    // failure leaves the source for a later launch and must not stop startup:
    // this runs before the app can render any error.
    if (current !== null && current !== old) {
      console.error(
        `Cannot migrate ${oldKey}: ${key} already contains different data`,
      );
      continue;
    }
    const copy = current === null ? storage.set(key, old) : Promise.resolve();
    moves.push(
      copy
        // The source goes once the copy is saved; until then it is the only
        // one.
        .then(() => storage.set(oldKey, null))
        .catch((error) => console.error(`Cannot migrate ${oldKey}`, error)),
    );
  }
  return Promise.all(moves).then(() => {});
}
