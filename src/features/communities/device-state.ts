import { forgetTabVisits } from "../messages/tab-visit-lifetime";
import { forgetCoreMemory } from "../agents/core-memory-cache";
import { forgetChannelSetups } from "../channel-templates/setup";
import { forgetQuickReactions } from "../messages/quick-reactions";
import { relayPartition } from "../relay/partition";
import { purgeRelayPartition } from "../relay/partition-purge";
import { forgetThreadFollows } from "../relay/thread-follows";
import { clearViewScope } from "../../shared/view-state";
import { saveLocalCommunityName } from "./names";
import { saveRepositoriesFolder } from "./repositories";

/** One piece of a left community's device state that could not be cleared. */
export type PurgeFailure = { store: string; error: unknown };

/** Records a store that could not be cleared. The membership is already gone,
 * so the failure is only observable through the console and the caller's
 * report; nothing retries it later. */
function purgeFailure(
  origin: string,
  store: string,
  error: unknown,
): PurgeFailure {
  console.warn(`Couldn't clear ${store} for ${origin} on this device`, error);
  return { store, error };
}

/** Forgets what this device keeps for one community and viewer: view intent
 * (selected channel, drafts, scroll and sidebar state), channel heads, the
 * read-state journal, the outbox and smaller preference stores. Every store is
 * partitioned by `origin:viewer`, so nothing here can touch another community.
 * Each store is cleared independently: an unavailable one does not keep the
 * others, and the caller has already dropped the membership. Every failure is
 * logged and returned, named by store, so the caller can say some saved data
 * remains. */
export async function purgeCommunityDeviceState(
  origin: string,
  viewer: string,
): Promise<PurgeFailure[]> {
  const scope = relayPartition(origin, viewer);
  const failures: PurgeFailure[] = [];
  const attempt = async (store: string, work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(purgeFailure(origin, store, error));
    }
  };
  // Agents' core memory is only ever held in memory, so this cannot fail.
  forgetCoreMemory(scope);
  forgetTabVisits(scope);
  await attempt("community display name", () => {
    saveLocalCommunityName(origin, viewer, "");
  });
  await attempt("repositories folder", () => {
    saveRepositoriesFolder(origin, viewer, "");
  });
  await attempt("view state", () => clearViewScope(scope));
  await attempt("channel setups", () => forgetChannelSetups(scope));
  await attempt("quick reactions", () => forgetQuickReactions(scope));
  await attempt("thread follows", () => forgetThreadFollows(scope));
  await purgeRelayPartition(origin, viewer, attempt);
  return failures;
}
