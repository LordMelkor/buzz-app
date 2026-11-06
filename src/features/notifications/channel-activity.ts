import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

/** Channels set to notify on all activity. Like other view intent it is saved
 * on this device under the relay partition (`origin:viewer`), so it is per
 * community and account and goes when the viewer leaves the community. */
const key = "notify-channels";

export function activityChannels(scope: string): readonly string[] {
  const saved = readView<unknown>(scope, key, []);
  return Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === "string")
    : [];
}

/** False when the choice could not be saved on this device. */
export function setChannelActivity(
  scope: string,
  channelId: string,
  on: boolean,
) {
  const next = activityChannels(scope).filter((id) => id !== channelId);
  if (on) next.push(channelId);
  return writeView(scope, key, next);
}

/** Windowless hosts (tests, workers) have no other windows to hear from. */
export function subscribeActivityChannels(scope: string, listener: () => void) {
  return typeof window === "undefined"
    ? () => {}
    : subscribeView(scope, listener);
}

export function useActivityChannels(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeActivityChannels(scope, listener),
    [scope],
  );
  const revision = useSyncExternalStore(subscribe, () =>
    viewRevision(scope, key),
  );
  return useMemo(
    // The revision is the saved value activityChannels() reads; it keys the memo.
    () => (revision !== undefined ? activityChannels(scope) : []),
    [revision, scope],
  );
}
