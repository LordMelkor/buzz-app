import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

export type FollowUpBehavior = "immediate" | "queue";
const preferenceKey = "buzz-follow-up-behavior.v1";
const changedEvent = "buzz-follow-up-behavior-changed";
let unsavedPreference: FollowUpBehavior | undefined;

/** Device-local agent follow-up behavior (Solo and channels); immediate sending remains the default. */
export function followUpBehaviorPreference(): FollowUpBehavior {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "queue"
      ? "queue"
      : "immediate";
  } catch {
    return "immediate";
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useFollowUpBehaviorPreference() {
  const behavior = useSyncExternalStore(subscribe, followUpBehaviorPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { behavior, unsaved };
}
export function setFollowUpBehaviorPreference(value: FollowUpBehavior): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Agent follow-up behavior as a device setting. */
export const followUpBehaviorSetting: DeviceSetting = {
  key: "conversations.follow_up_behavior",
  description:
    "Send follow-ups to agents immediately, or queue them on this device until the agent finishes its previous response. Applies in Solo and in channels where the agent you tag is working.",
  schema: { type: "string", enum: ["immediate", "queue"] },
  read: () => ({
    value: followUpBehaviorPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This behavior is active, but could not be saved on this device.",
  }),
  write: (value) => setFollowUpBehaviorPreference(value as FollowUpBehavior),
};
