import type { ReactNode } from "react";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { Profile } from "../relay/contracts";
import styles from "./Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";

/** Shared summary contents for channel threads and collapsed reply branches. */
export function ReplySummary({
  count,
  participants,
  profiles,
  agentPubkeys,
  resolveName,
  media,
  unreadLabel,
  unreadCount,
  workingParticipants = [],
  activity,
  hideEmptyLabel = false,
}: {
  workingParticipants?: readonly string[];
  activity?: ReactNode;
  /** Activity-only triggers already have an accessible thread action label. */
  hideEmptyLabel?: boolean;
  count: number;
  participants: readonly string[];
  profiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  resolveName(id: string, fallback: string): string;
  media(url: string, size?: "small"): string | undefined;
  unreadLabel?: string | undefined;
  unreadCount?: number;
}) {
  return (
    <>
      <AvatarStack
        size="small"
        items={[...new Set(participants)]
          .filter((id) => !workingParticipants.includes(id))
          .map((id) => {
            const profile = profiles?.get(id);
            return {
              id,
              name: resolveName(id, profile?.name ?? id.slice(0, 10)),
              src: avatarMedia(profile?.picture, media),
              shape: agentPubkeys?.has(id) ? "squircle" : "circle",
            };
          })}
      />
      {activity}
      {(count > 0 || !hideEmptyLabel) && (
        <span>
          {count > 0
            ? `${count} ${count === 1 ? "reply" : "replies"}`
            : "View thread"}
        </span>
      )}
      {unreadCount ? (
        <span>({unreadCount} new)</span>
      ) : unreadLabel ? (
        <span
          className={styles.threadUnread}
          aria-hidden="true"
          title={unreadLabel}
        />
      ) : null}
    </>
  );
}
