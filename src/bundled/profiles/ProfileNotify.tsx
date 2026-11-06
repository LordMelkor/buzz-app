import { useState, useSyncExternalStore } from "react";
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
  const listed = useSyncExternalStore(notifications.subscribe, () =>
    notifications.snapshot().preferences.people.includes(pubkey),
  );
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={() => setFailed(!notifications.setPerson(pubkey, !listed))}
      >
        {listed ? "Stop notifying" : "Notify me when they post"}
      </Button>
      {failed && (
        <p role="alert" className="text-body-sm text-danger">
          Couldn’t save this choice on this device. Try again.
        </p>
      )}
    </>
  );
}
