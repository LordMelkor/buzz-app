import { workflowLabel } from "../relay/workflow-attribution";
import {
  useChannelIdentityNames,
  useIdentityNames,
} from "../identity-names/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import type { ChannelReference } from "../relay/contracts";
import {
  LightningIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../channels/channel-icon";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./LinkPreview.module.css";
import { messagePreviewText } from "./message-preview-text";
import { linkedMessage } from "./linked-message";
import { avatarMedia } from "../../shared/avatar-source";
import { sortParticipantNames } from "../identity-names/participant-order";

/** Mounted only while a preview is open. The session owns access, edits and deletion. */
export function BuzzLinkPreview({
  session,
  channelId,
  messageId,
}: {
  session: RelaySession;
  channelId: string;
  messageId: string;
}) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState(false);
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch {
      setError(true);
    }
  }, [session, channelId, messageId]);
  if (error) return <span role="status">Message preview unavailable.</span>;
  return view ? (
    <PreviewContent view={view} session={session} messageId={messageId} />
  ) : (
    <span role="status">Loading message…</span>
  );
}

function PreviewContent({
  view,
  session,
  messageId,
}: {
  view: ThreadView;
  session: RelaySession;
  messageId: string;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const { message, ready, stopped } = linkedMessage(snapshot, messageId);
  const resolveName = useChannelIdentityNames(session, message?.channelId);
  const identityName = useIdentityNames(session.names);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const authorId = message?.workflowOwnerId ?? message?.authorId;
  useEffect(() => {
    if (authorId)
      void session.profiles.ensure([authorId], "background").catch(() => {});
  }, [session, authorId]);
  if (!ready || !message)
    return (
      <span role="status">
        {stopped ? "Message preview unavailable." : "Loading message…"}
      </span>
    );
  const displayId = message.workflowOwnerId ?? message.authorId;
  const profile = profiles.get(displayId);
  const resolved = resolveName(
    displayId,
    profile?.name ?? displayId.slice(0, 10),
  );
  const name = message.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const date = new Date(message.createdAt * 1000);
  if (!Number.isFinite(date.getTime()))
    return <span role="status">Message preview unavailable.</span>;
  const channel = channels.channels.find(
    (item) => item.id === message.channelId,
  );
  const channelName =
    channel?.channelType === "dm" && channel.participants
      ? sortParticipantNames(
          channel.participants.map((id) =>
            identityName(
              id,
              profiles.get(id)?.name ?? id.slice(0, 10),
              channel.participants,
            ),
          ),
        ).join(", ") || "Notes to self"
      : (channel?.name ?? "Channel unavailable");
  const ChannelIcon =
    channel?.hidden || channel?.channelType === "dm"
      ? LockIcon
      : channelIcon(channel);
  return (
    <>
      <span className={styles.byline}>
        <Avatar
          alt={name}
          fallback={name}
          fallbackContent={
            message.workflowOwnerId ? <LightningIcon size={20} /> : undefined
          }
          shape={message.workflowOwnerId ? "squircle" : "circle"}
          src={
            message.workflowOwnerId
              ? null
              : avatarMedia(profile?.picture, session.media)
          }
        />
        <span className={styles.metadata}>
          <span className={styles.author}>
            <strong>{name}</strong>
            <time
              dateTime={date.toISOString()}
              title={date.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}
            >
              {relativeTimestamp(message.createdAt)}
            </time>
          </span>
          <span className={styles.channel}>
            {channel && <ChannelIcon aria-hidden="true" size={13} />}
            <span>{channelName}</span>
          </span>
        </span>
      </span>
      <span className={styles.message}>
        {messagePreviewText(message.content) ||
          (message.attachments.length ? "Attachment" : "Empty message")}
      </span>
    </>
  );
}

/** Hover card for a channel-only link. The store supplies what the reader
 * may see; a nonmember sees an open channel's public metadata, never its
 * roster. */
export function ChannelLinkPreview({
  channel,
}: {
  channel: Extract<ChannelReference, { state: "found" }>;
}) {
  const Icon = channelIcon(channel.private ? { private: true } : undefined);
  const details = [
    channel.private ? "Private channel" : "Public channel",
    channel.archived ? "Archived" : "",
    channel.joined ? "Joined" : "Not joined",
    channel.members
      ? `${channel.members} ${channel.members === 1 ? "member" : "members"}`
      : "",
  ].filter(Boolean);
  return (
    <>
      <span className={styles.byline}>
        <Icon aria-hidden="true" size={20} />
        <span className={styles.metadata}>
          <span className={styles.author}>
            <strong>{channel.name}</strong>
          </span>
          <span className={styles.channel}>
            <span>{details.join(" · ")}</span>
          </span>
        </span>
      </span>
      {channel.description && (
        <span className={styles.message}>{channel.description}</span>
      )}
    </>
  );
}
