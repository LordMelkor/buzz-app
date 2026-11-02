import type { ChatMenuProps } from "../../features/conversation/service";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelLauncherProps } from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { useIncomingHuddle } from "../../features/huddle/use-incoming";
import type { Huddles } from "../../features/huddle/service";
import {
  HeadphonesIcon,
  PhoneDisconnectIcon,
  CaretDownIcon,
  LinkIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuNote,
} from "../../shared/design-system/ui/Menu";
import { ChannelMembersDialog } from "../channels/ChannelMembersDialog";
import styles from "./Huddles.module.css";
import { writeClipboardText } from "../../shared/clipboard";

type Props = Pick<
  ChannelLauncherProps,
  "context" | "available" | "openMembers"
> & {
  relay: RelayData;
  huddles: Huddles;
  showWindow(): Promise<void>;
  menu?: boolean;
};
const focusPlayer = () => document.getElementById("huddle-capsule")?.focus();

/** The same call action, contributed to Solo's existing action menus. */
export function SoloHuddleMenu({
  session,
  channelId,
  relay,
  huddles,
  showWindow,
}: ChatMenuProps & Pick<Props, "relay" | "huddles" | "showWindow">) {
  const connection = useRelayConnection(relay);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = list.channels.find((item) => item.id === channelId);
  if (
    connection.session !== session ||
    !connection.scope ||
    !connection.viewer ||
    channel?.channelType !== "solo" ||
    channel.archived ||
    channel.readOnly ||
    channel.cached
  )
    return null;
  const context = {
    scope: connection.scope,
    viewer: connection.viewer,
    channelId,
    channelName: channel.name,
    relayUrl: connection.scope
      .slice(0, -(connection.viewer.length + 1))
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:"),
  };
  return (
    <HuddleLauncher
      menu
      context={context}
      relay={relay}
      huddles={huddles}
      showWindow={showWindow}
      available={() => relay.snapshot() === connection}
    />
  );
}

export function HuddleLauncher(props: Props) {
  const { context, available, huddles } = props;
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const connection = useRelayConnection(props.relay);
  const incoming = useIncomingHuddle(
    connection.scope === context.scope && connection.viewer === context.viewer
      ? connection.session
      : undefined,
    context.channelId,
  );
  const list = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
  );
  const parent = list.channels.find(
    (channel) => channel.id === context.channelId,
  );
  const active = ["connecting", "connected", "leaving"].includes(call.phase);
  const here =
    call.phase === "connected" &&
    call.destination?.scope === context.scope &&
    call.destination.viewer === context.viewer &&
    call.destination.channelId === context.channelId;
  if (parent?.archived) return null;
  if (props.menu && active) return null;
  if (here && call.id)
    return <ActiveHuddle key={call.id} {...props} callId={call.id} />;
  const joinable =
    !active && incoming && huddles.canJoin(context.scope, incoming.id);
  const label =
    call.phase === "connecting"
      ? "Cancel Huddle connection"
      : active
        ? "Show active Huddle"
        : joinable
          ? parent?.channelType === "solo"
            ? "Join huddle"
            : `Join active huddle (${incoming.participants} ${incoming.participants === 1 ? "participant" : "participants"})`
          : parent?.channelType === "solo"
            ? "Start a huddle"
            : "Start or join a huddle";
  const activate = () => {
    if (!available()) return;
    if (call.phase === "connecting") void huddles.leave();
    else if (active) {
      if (document.getElementById("huddle-capsule")) focusPlayer();
      else void props.showWindow().catch(() => {});
    } else if (joinable) void huddles.join(context, incoming.id);
    else void huddles.start(context);
  };
  if (props.menu)
    return (
      <MenuItem onClick={activate}>
        <MenuIcon>
          <HeadphonesIcon size={16} />
        </MenuIcon>
        {label}
      </MenuItem>
    );
  // Keep active/incoming calls visible; idle Solo calls live in Chat actions.
  if (parent?.channelType === "solo" && !active && !joinable) return null;
  return (
    <span className={joinable ? styles.activeLauncher : undefined}>
      <IconButton
        size="toolbar"
        variant="ghost"
        icon={<HeadphonesIcon size={16} aria-hidden="true" />}
        style={joinable ? { color: "var(--status-online)" } : undefined}
        aria-label={label}
        title={label}
        onClick={activate}
      />
    </span>
  );
}

function ActiveHuddle({
  context,
  available,
  relay,
  huddles,
  callId,
}: Props & { callId: string }) {
  const connection = useRelayConnection(relay);
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const [membersOpen, setMembersOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
  );
  const room =
    list.channels.find((c) => c.id === call.room) ??
    (call.room ? connection.session.channels.get?.(call.room) : undefined);
  const canInvite =
    !!room &&
    room.huddle === true &&
    room.parentChannelId === context.channelId &&
    !room.archived;
  useEffect(() => {
    if (call.room)
      void connection.session.channels.resolve?.([call.room]).catch(() => {});
  }, [connection.session, call.room]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const current = () =>
    available() &&
    huddles.snapshot().id === callId &&
    huddles.snapshot().phase === "connected";
  // Existing Buzz channel links preserve membership checks. Joining remains an
  // explicit headphone click in the destination, never automatic mic capture.
  const link = `buzz://channel/${encodeURIComponent(context.channelId)}`;
  return (
    <>
      <fieldset
        className={styles.activeLauncher}
        aria-label="Active Huddle in this chat"
      >
        <IconButton
          size="toolbar"
          variant="ghost"
          style={{ color: "var(--status-online)" }}
          data-huddle-leave=""
          aria-label="Leave huddle"
          title="Leave huddle"
          icon={
            <span className={styles.leaveGlyph} aria-hidden="true">
              <HeadphonesIcon size={16} className={styles.headphonesGlyph} />
              <PhoneDisconnectIcon
                size={16}
                className={styles.disconnectGlyph}
              />
            </span>
          }
          onClick={() => {
            if (current()) void huddles.leave();
          }}
        />
        <span className={styles.launcherDivider} aria-hidden="true" />
        <MenuRoot
          onOpenChange={(open) => {
            if (open) {
              setCopied(false);
              setError(false);
            }
          }}
        >
          <MenuTrigger
            render={
              <IconButton
                size="toolbar"
                variant="ghost"
                style={{ color: "var(--status-online)" }}
                ref={trigger}
                aria-label="Huddle options"
                icon={<CaretDownIcon size={16} aria-hidden="true" />}
              />
            }
          />
          <MenuPopup align="end" size="compact">
            <MenuItem
              disabled={!canInvite}
              onClick={() => {
                if (current()) setMembersOpen(true);
              }}
            >
              <MenuIcon>
                <UsersIcon size={16} />
              </MenuIcon>
              Add someone
            </MenuItem>
            <MenuItem
              closeOnClick={false}
              onClick={async () => {
                if (!current()) return;
                setError(false);
                try {
                  await writeClipboardText(link);
                  setCopied(true);
                } catch {
                  setError(true);
                }
              }}
            >
              <MenuIcon>
                <LinkIcon size={16} />
              </MenuIcon>
              {copied ? "Link copied" : "Copy link"}
            </MenuItem>
            {error && (
              <MenuNote role="alert">
                Couldn’t copy. You can copy this link manually: {link}
              </MenuNote>
            )}
          </MenuPopup>
        </MenuRoot>
      </fieldset>
      {membersOpen && current() && canInvite && call.room && (
        <ChannelMembersDialog
          session={connection.session}
          channelId={call.room}
          title="Huddle members"
          description="People added here can join this Huddle and its thread. The original chat stays private."
          close={() => setMembersOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}
