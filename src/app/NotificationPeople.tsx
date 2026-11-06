import { useIdentityNames } from "../features/identity-names/react";
import type { IdentityNameView } from "../features/identity-names/service";
import type { NotificationsService } from "../features/notifications/service";
import { UsersIcon } from "../shared/design-system/icons";
import { Button } from "../shared/design-system/ui/Button";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { formatPublicKey } from "../shared/identity/public-key";

/** The people whose posts notify, to review one by one or clear. They are
 * added from a profile, where the person is in front of you. */
export function NotificationPeople({
  notifications,
  people,
  names,
}: {
  notifications: NotificationsService;
  people: readonly string[];
  names: IdentityNameView | undefined;
}) {
  const label = useIdentityNames(names);
  return (
    <section aria-labelledby="notification-people-title">
      <InlineHeader
        id="notification-people-title"
        title="People on your list"
        subtitle="Get a notification when they post in a channel you’re in."
        actions={
          people.length > 0 && (
            <Button
              size="compact"
              variant="ghost"
              onClick={() => notifications.updatePreferences({ people: [] })}
            >
              Clear list
            </Button>
          )
        }
      />
      {people.length === 0 ? (
        <EmptyState
          level={4}
          icon={<UsersIcon size={24} />}
          title="No one on your list"
          description="Open someone’s profile and choose Notify me when they post."
        />
      ) : (
        <SettingsGroup>
          {people.map((pubkey) => {
            const name = label(
              pubkey,
              formatPublicKey(pubkey) ?? pubkey.slice(0, 8),
            );
            return (
              <PreferenceRow
                key={pubkey}
                title={name}
                trailing={
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => notifications.setPerson(pubkey, false)}
                  >
                    Remove
                  </Button>
                }
              />
            );
          })}
        </SettingsGroup>
      )}
    </section>
  );
}
