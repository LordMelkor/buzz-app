import {
  setChannelActivity,
  useActivityChannels,
} from "../features/notifications/channel-activity";
import type { ChannelQueries } from "../features/relay/contracts";
import { useChannelList } from "../features/relay/react";
import { HashIcon } from "../shared/design-system/icons";
import { Button } from "../shared/design-system/ui/Button";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";

/** The selected community's channels set to notify on all activity, to turn
 * off one by one. They are turned on from the channel's menu, beside Mute. */
export function NotificationChannels({
  scope,
  channels,
}: {
  scope: string;
  channels: ChannelQueries;
}) {
  const chosen = useActivityChannels(scope);
  const list = useChannelList(channels);
  return (
    <section aria-labelledby="notification-channels-title">
      <InlineHeader
        id="notification-channels-title"
        title="Channels with all activity"
        subtitle="Get a notification for every post in these channels, not only mentions and your conversations."
      />
      {chosen.length === 0 ? (
        <EmptyState
          level={4}
          icon={<HashIcon size={24} />}
          title="No channels set to all activity"
          description="Open a channel’s menu and choose Notify for all activity."
        />
      ) : (
        <SettingsGroup>
          {chosen.map((id) => {
            const name = `#${list.channels.find((channel) => channel.id === id)?.name ?? id.slice(0, 8)}`;
            return (
              <PreferenceRow
                key={id}
                title={name}
                trailing={
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-label={`Turn off all activity for ${name}`}
                    onClick={() => setChannelActivity(scope, id, false)}
                  >
                    Turn off
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
