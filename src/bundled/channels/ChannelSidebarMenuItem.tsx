import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { channelIcon } from "../../features/channels/channel-icon";
import { CheckIcon } from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import { UnreadBadge, useUnreadState } from "./UnreadBadge";
import { useWorkingAgents } from "./useWorkingAgents";
import { WorkingAgentsBadge } from "./WorkingAgentsBadge";
import styles from "./Channels.module.css";

/** A channel choice shares sidebar evidence, while retaining native menu behavior. */
export function ChannelSidebarMenuItem({
  channel,
  session,
  selected,
  onSelect,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  selected: boolean;
  onSelect: () => void;
}) {
  const dm = channel.channelType === "dm";
  const Icon = channelIcon(channel);
  const { ordinary } = useUnreadState(session, channel.id, dm);
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    channel.id,
    true,
  );
  return (
    <MenuItem aria-current={selected ? "page" : undefined} onClick={onSelect}>
      <MenuIcon>
        <Icon size={14} />
      </MenuIcon>
      <span
        className={styles.channelMenuLabel}
        data-ordinary={ordinary || undefined}
      >
        {channel.name}
      </span>
      <MenuTrailing>
        <span className={styles.channelMenuIndicators}>
          <span className={styles.indicatorStack}>
            <span className={styles.indicatorLayer}>
              <UnreadBadge session={session} channelId={channel.id} dm={dm} />
            </span>
            <WorkingAgentsBadge
              agents={agents}
              profiles={agentProfiles}
              channelName={channel.name}
              waiting={waiting}
            />
          </span>
          {selected && <CheckIcon size={14} />}
        </span>
      </MenuTrailing>
    </MenuItem>
  );
}
