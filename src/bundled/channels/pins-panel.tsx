import { useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import { useListedChannel } from "../../features/relay/listed-channel";
import { diffPreview } from "../../features/relay/membership";
import { PIN_KIND, pinLists } from "../../features/relay/pins";
import { useRelayConnection, useRowProfiles } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { MessageTimestamp } from "../../features/messages/MessageTimestamp";
import {
  usePinnedMessages,
  usePinnedRows,
} from "../../features/messages/use-pins";
import { PinIcon, PinOffIcon, XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./PinsPanel.module.css";

function Launcher({
  context,
  pressed,
  toggle,
  relay,
}: ChannelLauncherProps & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const current = connection.scope === context.scope;
  const solo = useListedChannel(
    connection.session.channels,
    context.channelId,
    (channel) => channel?.channelType === "solo",
  );
  const pins = usePinnedMessages(
    connection.session,
    current && connection.session.workflowAuthority
      ? context.channelId
      : undefined,
  );
  // Where this host sends pin commands, or still lists some pins.
  // A Solo chat offers no pins.
  if (
    !current ||
    solo ||
    (!connection.session.outbox?.supports(PIN_KIND) && !pins.ids.length)
  )
    return null;
  return (
    <IconButton
      size="toolbar"
      icon={<PinIcon size={16} aria-hidden="true" />}
      aria-label="Pinned messages"
      title="Pinned messages"
      aria-expanded={pressed}
      onClick={(event) => {
        event.currentTarget.focus();
        toggle(context.channelId);
      }}
    />
  );
}

const preview = (row: ChannelMessage) =>
  row.diff
    ? diffPreview(row.diff)
    : row.content.trim() || (row.attachments.length ? "Attachment" : "");

function PinnedList({
  session,
  channelId,
  open,
}: {
  session: RelaySession;
  channelId: string;
  open(row: ChannelMessage): void;
}) {
  const [attempt, setAttempt] = useState(0);
  const pins = usePinnedMessages(session, channelId);
  const pinned = usePinnedRows(session, channelId, pins.ids, attempt);
  const profiles = useRowProfiles(session.profiles, pinned.rows);
  const resolveName = useChannelIdentityNames(session, channelId);
  const canUnpin = useListedChannel(
    session.channels,
    channelId,
    (channel) =>
      !!channel && !channel.readOnly && !channel.cached && !channel.archived,
  );
  const dm = useListedChannel(
    session.channels,
    channelId,
    (channel) => channel?.channelType === "dm",
  );
  const [error, setError] = useState<string>();
  const retry = () =>
    pins.status === "error"
      ? pinLists(session).retry(channelId)
      : setAttempt((value) => value + 1);
  const pinnable = !!session.outbox?.supports(PIN_KIND);
  if (
    pins.status === "error" ||
    (pinned.status === "error" && !pinned.rows.length)
  )
    return (
      <EmptyState
        icon={<PinIcon />}
        title="Couldn’t load pinned messages"
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  if (
    pins.status === "loading" ||
    (pinned.status === "loading" && !pinned.rows.length && pins.ids.length)
  )
    return (
      <p role="status" className={styles.status}>
        Loading pinned messages…
      </p>
    );
  if (!pinned.rows.length)
    return (
      <EmptyState
        icon={<PinIcon />}
        title="No pinned messages"
        {...(pinnable && {
          description: "Pin a message from its More menu to keep it here.",
        })}
      />
    );
  return (
    <>
      {/* A failed refresh retries in the background, keeping these rows. */}
      {error && (
        <p role="alert" className={styles.status}>
          {error}
        </p>
      )}
      <ul className={styles.list} aria-label="Pinned messages">
        {pinned.rows.map((row) => {
          const name = resolveName(
            row.authorId,
            profiles.get(row.authorId)?.name ?? row.authorId.slice(0, 10),
          );
          return (
            <li key={row.id} className={styles.row}>
              <button
                type="button"
                className={styles.open}
                onClick={() => open(row)}
              >
                <span className={styles.byline}>
                  <strong>{name}</strong>
                  <MessageTimestamp createdAt={row.createdAt} />
                </span>
                <span className={styles.preview}>{preview(row)}</span>
              </button>
              {canUnpin && pinnable && (
                <IconButton
                  size="sm"
                  aria-label={`Unpin message from ${name}`}
                  title={dm ? "Unpin from DM" : "Unpin from channel"}
                  icon={<PinOffIcon size={14} aria-hidden="true" />}
                  onClick={() => {
                    setError(undefined);
                    try {
                      session.messages.pin(channelId, row.id, false);
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not unpin. Try again.",
                      );
                    }
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function registerPins(ctx: Context) {
  function Panel({ channelContext, close }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const ready =
      !!channelContext &&
      state.status === "ready" &&
      state.scope === channelContext.scope;
    return (
      <div className={styles.panel}>
        <PanelHeader
          title="Pinned"
          actions={
            <IconButton
              size="toolbar"
              aria-label="Close pinned messages"
              onClick={close}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          }
        />
        <div className={styles.body}>
          {ready && state.origin && state.viewer ? (
            <PinnedList
              key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
              session={state.session}
              channelId={channelContext.channelId}
              open={(row) => {
                // As a message link does: the message replaces the list.
                close();
                void ctx.navigation.open({
                  version: 1,
                  kind: "conversation",
                  scope: {
                    viewer: state.viewer ?? "",
                    communityOrigin: state.origin ?? "",
                  },
                  channelId: row.channelId,
                  messageId: row.id,
                  ...(row.threadRootId
                    ? { threadRootId: row.threadRootId }
                    : {}),
                });
              }}
            />
          ) : (
            <p role="status" className={styles.status}>
              Pinned messages are unavailable while the connection recovers.
            </p>
          )}
        </div>
      </div>
    );
  }
  ctx.panels.register({
    id: "pins",
    title: "Pinned",
    matches: () => false,
    channelLauncher: (props) => <Launcher {...props} relay={ctx.relay} />,
    channelPlacement: "side",
    component: Panel,
  });
}
