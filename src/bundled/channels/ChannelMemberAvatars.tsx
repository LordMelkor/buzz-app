import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { UsersIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";

/** The members trigger previews people; the dialog still includes every member. */
export function ChannelMemberAvatars({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const members = channel?.members ?? [];
  const memberKey = members.join(":");
  useEffect(() => {
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":"), "background")
        .catch(() => {});
  }, [session, memberKey]);
  const agents = new Set(choices.identities.map((agent) => agent.pubkey));
  const people = members
    .filter((id) => !agents.has(id) && !profiles.get(id)?.isAgent)
    // Prefer recognizable photos over key-only placeholders.
    .sort(
      (a, b) =>
        Number(!!profiles.get(b)?.picture) - Number(!!profiles.get(a)?.picture),
    );
  if (!people.length) return <UsersIcon size="1rem" aria-hidden="true" />;
  const shown = 3;
  return (
    <AvatarStack
      size="small"
      max={shown}
      items={people.map((id, index) =>
        // Members past the shown ones only count.
        index < shown
          ? {
              id,
              name: resolveName(
                id,
                profiles.get(id)?.name ?? formatPublicKey(id) ?? "Member",
              ),
              src: avatarMedia(profiles.get(id)?.picture, session.media),
              shape: "circle",
            }
          : { id, name: "", shape: "circle" },
      )}
    />
  );
}
