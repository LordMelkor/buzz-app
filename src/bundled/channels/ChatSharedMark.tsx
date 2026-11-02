import { useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";
import { avatarMedia } from "../../shared/avatar-source";
import { UsersIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";

/** Unknown classification is not evidence of a private conversation. Only a
 * verified current roster plus a known non-agent profile supplies Shared. */
export function useSharedWithPeople(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const roles = useSyncExternalStore(
    session.memberAdministration.subscribe,
    () =>
      channel ? session.memberAdministration.snapshot(channel.id) : undefined,
  );
  const human =
    !channel?.cached &&
    channel?.members?.some((key) => {
      const profile = profiles.get(key);
      return (
        key !== session.viewer &&
        roles?.authority.roles[key] !== "bot" &&
        profile &&
        !profile.isAgent &&
        !profile.nameIsFallback &&
        !agents.identities.some((agent) => agent.pubkey === key)
      );
    });
  return !!human;
}

/** The person whose Solo chat another member is viewing. Absent in the
 * viewer's own chats and until the creator's profile is known. */
export function useSoloOwner(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const creator = channel?.creator;
  if (
    channel?.channelType !== "solo" ||
    !creator ||
    ownSolo(channel, session.viewer)
  )
    return undefined;
  const profile = profiles.get(creator);
  if (!profile || profile.nameIsFallback) return undefined;
  return {
    name: profile.name,
    picture: avatarMedia(profile.picture, session.media),
  };
}

export const soloOwnerLabel = (owner: { name: string }) =>
  `${owner.name}’s chat`;

export function SoloOwnerAvatar({
  owner,
}: {
  owner: { name: string; picture?: string | undefined };
}) {
  return (
    <Avatar src={owner.picture} alt="" fallback={owner.name} size="compact" />
  );
}

/** Opens the chat's access list. The row's select button is described by it
 * through `soloSharedMarkId`. */
export const soloSharedMarkId = (channelId: string) =>
  `solo-shared-${channelId}`;

export function ChatSharedMark({
  session,
  channel,
  onOpen,
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
  onOpen(trigger: HTMLElement): void;
}) {
  const shared = useSharedWithPeople(session, channel);
  const owner = useSoloOwner(session, channel);
  if (!channel || (!shared && !owner)) return null;
  const label = owner ? soloOwnerLabel(owner) : "Shared";
  return (
    <>
      <IconButton
        data-solo-shared=""
        variant={owner ? "avatar" : "bare"}
        size="compact"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        onClick={(event) => onOpen(event.currentTarget)}
        icon={
          owner ? (
            <SoloOwnerAvatar owner={owner} />
          ) : (
            <UsersIcon size={16} aria-hidden="true" />
          )
        }
      />
      <span id={soloSharedMarkId(channel.id)} hidden>
        {label}
      </span>
    </>
  );
}
