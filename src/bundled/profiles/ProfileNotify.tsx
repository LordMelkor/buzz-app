import { useCallback, useState, useSyncExternalStore } from "react";
import { MAX_NOTIFICATION_PEOPLE } from "../../features/notifications/preferences";
import type { NotificationPeople } from "../../features/notifications/service";
import { Button } from "../../shared/design-system/ui/Button";

/** Adds or removes this person from the list whose posts notify the viewer. */
export function ProfileNotify({
  notifications,
  pubkey,
  variant,
}: {
  notifications: NotificationPeople;
  pubkey: string;
  variant: "glass" | "subtle";
}) {
  // The list checks who calls it, so keep its methods bound to it.
  const subscribe = useCallback(
    (listener: () => void) => notifications.subscribe(listener),
    [notifications],
  );
  const listed = useSyncExternalStore(subscribe, () =>
    notifications.snapshot().preferences.people.includes(pubkey),
  );
  const [problem, setProblem] = useState<"full" | "unsaved" | null>(null);
  // A failed save still applies the choice, so a retry saves it as it is.
  // A full list changes nothing, so it gets its own message and no retry.
  const save = (next: boolean) => {
    const { people } = notifications.snapshot().preferences;
    if (next && !listed && people.length >= MAX_NOTIFICATION_PEOPLE)
      return setProblem("full");
    setProblem(notifications.setPerson(pubkey, next) ? null : "unsaved");
  };
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => save(!listed)}>
        {listed ? "Stop notifying" : "Notify me when they post"}
      </Button>
      {problem === "full" && (
        <p role="alert" className="text-body-sm text-danger">
          Your list is full ({MAX_NOTIFICATION_PEOPLE} people). Remove someone
          in Settings → Notifications first.
        </p>
      )}
      {problem === "unsaved" && (
        <p role="alert" className="text-body-sm text-danger">
          Couldn’t save this choice on this device.{" "}
          <Button size="sm" variant="subtle" onClick={() => save(listed)}>
            Retry saving
          </Button>
        </p>
      )}
    </>
  );
}
