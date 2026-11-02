import { workflowLabel } from "../../features/relay/workflow-attribution";
import { LightningIcon } from "../../shared/design-system/icons";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { EnvelopeOpenIcon } from "../../shared/design-system/icons";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ComponentProps,
} from "react";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadActivityItem } from "../../features/relay/unread";
import { Avatar } from "../../shared/Avatar";
import { Avatar as WorkflowAvatar } from "../../shared/design-system/ui/Avatar";
import { publicKeyLabels } from "../../shared/identity/public-key";
import styles from "./Channels.module.css";
import activityStyles from "../../features/agents/ActivityRows.module.css";
import { AgentActivityRow } from "../../features/agents/AgentActivityRow";
import { workingAgentDetails } from "./working-agents";
import { avatarMedia } from "../../shared/avatar-source";

const elapsed = (createdAt: number, now = Date.now()) => {
  const seconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const workingDuration = (startedAt: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
};
const noSubscribe = () => () => {};

function ActivityRow({
  item,
  session,
  agents,
  onOpen,
}: {
  item: ThreadActivityItem;
  session: RelaySession;
  agents: readonly string[];
  onOpen(item: ThreadActivityItem): void;
}) {
  const selection = useMemo(
    () =>
      selectProfiles(session.profiles, [item.workflowOwnerId ?? item.authorId]),
    [session.profiles, item.authorId, item.workflowOwnerId],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const displayId = item.workflowOwnerId ?? item.authorId;
  const profile = profiles.get(displayId);
  const resolveName = useChannelIdentityNames(session, item.channelId);
  const resolved = resolveName(
    displayId,
    profile?.name ?? displayId.slice(0, 10),
  );
  const name = item.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const isAgent =
    agents.includes(item.authorId) ||
    !!profile?.isAgent ||
    session.agentChoices
      .snapshot()
      .identities.some(({ pubkey }) => pubkey === item.authorId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const markRead = async () => {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      await session.unread.markThrough(
        { kind: "thread", channelId: item.channelId, rootId: item.rootId },
        item.latestMessageId,
      );
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className={`${activityStyles.activityItem} ${activityStyles.activityItemWithAction}`}
    >
      <NavigationItem
        type="button"
        aria-label={`Open unread thread from ${name}: ${item.preview}`}
        onClick={() => onOpen(item)}
        icon={
          item.workflowOwnerId ? (
            <WorkflowAvatar
              alt="Workflow"
              fallback="Workflow"
              fallbackContent={<LightningIcon size={20} />}
              shape="squircle"
            />
          ) : (
            <Avatar
              name={name}
              src={avatarMedia(profile?.picture, session.media)}
              shape={isAgent ? "squircle" : "circle"}
              className={activityStyles.activityAvatar ?? ""}
            />
          )
        }
        label={
          <span className={activityStyles.activityItemBody}>
            <span className={activityStyles.activityItemHeading}>
              <strong>{name}</strong>
              <span className={activityStyles.activityTimestamp}>
                {elapsed(item.createdAt)}
              </span>
            </span>
            <span className={styles.activityItemPreview}>{item.preview}</span>
          </span>
        }
      />
      <span className={activityStyles.activityItemAction}>
        <IconButton
          size="toolbar"
          icon={<EnvelopeOpenIcon />}
          aria-label={`Mark thread from ${name} as read`}
          title="Mark as read"
          loading={pending}
          onClick={() => void markRead()}
        />
      </span>
      {error && (
        <p className={styles.activityReadError} role="alert">
          Could not mark this thread as read. Try again.
        </p>
      )}
    </div>
  );
}

export function ChannelActivityPopover({
  session,
  channelId,
  channelName,
  trigger,
  agents,
  agentProfiles,
  onOpenWorkingAgent,
  onOpenAgentActivity,
  onOpenThread,
}: {
  session: RelaySession;
  channelId: string;
  channelName: string;
  trigger: ReactElement;
  agents?: readonly string[];
  agentProfiles?: ReadonlyMap<string, Profile>;
  onOpenWorkingAgent?: (
    channelId: string,
    agent: string,
    messageId: string | undefined,
  ) => void;
  onOpenAgentActivity?: (channelId: string, agent: string) => void;
  onOpenThread(item: ThreadActivityItem): void;
}) {
  const subscribe = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const get = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const items = snapshot.items ?? [];
  const activeAgents = agents ?? [];
  const agentIds = activeAgents.join(",");
  const [open, setOpen] = useState(false);
  const triggerPointerType = useRef<string | null>(null);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  const pressedOpen = useRef(false);
  // An opened thread takes focus itself. Base UI returns focus to the trigger
  // in a microtask after closing, which can land after, and steal it from, the
  // thread.
  const handoff = useRef(false);
  // Hover opens a transient preview. Selecting its row may still take focus.
  const [preview, setPreview] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !activeAgents.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, activeAgents.length]);
  const getTargets = useCallback(() => {
    if (!agentIds) return "[]";
    const activity = session.agentActivity.snapshot();
    return JSON.stringify(
      agentIds
        .split(",")
        .map(
          (agent) => workingAgentDetails(activity, channelId, agent) ?? null,
        ),
    );
  }, [session, channelId, agentIds]);
  const details = JSON.parse(
    useSyncExternalStore(
      open && activeAgents.length
        ? session.agentActivity.subscribe
        : noSubscribe,
      getTargets,
      getTargets,
    ),
  ) as ({
    startedAt: number;
    messageId?: string;
    label?: string;
  } | null)[];
  const keyLabels = publicKeyLabels(activeAgents);
  const hasActivity = items.length > 0 || activeAgents.length > 0;
  useEffect(() => {
    if (!hasActivity && open) actions.current?.close();
  }, [hasActivity, open]);
  const stale = items.length > 0 && snapshot.freshness === "stale";
  // Row actions close through Base UI so its hover/press state resets; the
  // sidebar trigger stays mounted after the navigation they start.
  const close = () => {
    if (actions.current) actions.current.close();
    else setOpen(false);
  };
  return (
    <PopoverRoot
      modal={false}
      open={open}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        if (next && !hasActivity) return details.cancel();
        if (details.reason === "trigger-press") {
          const mousePress =
            triggerPointerType.current === "mouse" &&
            details.event instanceof MouseEvent &&
            details.event.detail > 0;
          triggerPointerType.current = null;
          if (mousePress) {
            details.cancel();
            return;
          }
        }
        // A queued hover dismissal must not close a newer keyboard/touch opening.
        if (
          !next &&
          details.reason === "trigger-hover" &&
          pressedOpen.current
        ) {
          details.cancel();
          return;
        }
        pressedOpen.current = next && details.reason === "trigger-press";
        setPreview(next && details.reason === "trigger-hover");
        setOpen(next);
        if (next) {
          handoff.current = false;
          setNow(Date.now());
        }
        if (next && items.length)
          void session.profiles
            .ensure(
              [
                ...new Set(
                  items.map(
                    ({ authorId, workflowOwnerId }) =>
                      workflowOwnerId ?? authorId,
                  ),
                ),
              ],
              "background",
            )
            .catch(() => {});
      }}
    >
      <PopoverTrigger
        render={trigger}
        data-popup-preview={preview ? "" : undefined}
        openOnHover={hasActivity && "preview"}
        onPointerDown={(event) => {
          triggerPointerType.current = event.pointerType;
        }}
      />
      <PopoverPopup
        data-channel-activity=""
        side="right"
        align="start"
        sideOffset={6}
        size="wide"
        padding="list"
        aria-label={`Activity in ${channelName}`}
        finalFocus={() => !handoff.current}
      >
        {open && (
          <div className={activityStyles.activityList}>
            {stale && (
              <p className={styles.activityStale}>May be out of date</p>
            )}
            {activeAgents.length > 0 && (
              <section aria-label="Agents working now">
                <h2 className={activityStyles.activitySectionLabel}>
                  Working now
                </h2>
                {activeAgents.map((agent, index) => {
                  const profile = agentProfiles?.get(agent);
                  const name = profile?.name ?? keyLabels.get(agent) ?? "Agent";
                  const { messageId, startedAt, label } = details[index] ?? {};
                  return (
                    <AgentActivityRow
                      key={agent}
                      name={name}
                      picture={avatarMedia(profile?.picture, session.media)}
                      status={label ?? "Working"}
                      meta={
                        startedAt === undefined
                          ? "—"
                          : workingDuration(startedAt, now)
                      }
                      openLabel={`Open ${messageId ? "thread" : "conversation"} for ${name} in ${channelName}`}
                      onOpen={() => {
                        close();
                        onOpenWorkingAgent?.(channelId, agent, messageId);
                      }}
                      onOpenActivity={
                        onOpenAgentActivity
                          ? () => {
                              close();
                              onOpenAgentActivity(channelId, agent);
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </section>
            )}
            {items.length > 0 && (
              <section aria-label="Unread threads">
                <h2 className={activityStyles.activitySectionLabel}>
                  Unread threads
                </h2>
                {items.map((item) => (
                  <ActivityRow
                    key={item.rootId}
                    item={item}
                    session={session}
                    agents={activeAgents}
                    onOpen={(selected) => {
                      handoff.current = true;
                      close();
                      onOpenThread(selected);
                    }}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
