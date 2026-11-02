import { useSyncExternalStore } from "react";

export type FollowUpBehavior = "immediate" | "queue";
const preferenceKey = "buzz-follow-up-behavior.v1";
const changedEvent = "buzz-follow-up-behavior-changed";
let unsavedPreference: FollowUpBehavior | undefined;

/** Device-local Solo follow-up behavior; immediate sending remains the default. */
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
