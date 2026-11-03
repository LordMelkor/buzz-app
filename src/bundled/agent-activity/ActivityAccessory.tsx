import { activityTranscript } from "../../features/agents/activity-transcript";
import { useRecordedActivityAgents } from "../../features/conversation/typing-presentation";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useProfileGeneration } from "../../features/relay/react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { activityRecords } from "../../features/agents/activity-records";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  OctagonIcon,
  WarningCircleIcon,
  XIcon,
  ArrowUpRightIcon,
} from "../../shared/design-system/icons";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { ActivityStepPreview } from "../../features/messages/ActivityStepPreview";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { currentActivity } from "./current-activity";
import { messageWork } from "./message-activity";
import type { ActivityTurn } from "../../features/agents/activity";
import { workStop, type WorkStopAgents } from "../../features/agents/work-stop";
import { useWorkStops } from "../../features/agents/use-work-stops";
import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";
import {
  localWorkLabel,
  type WorkStep,
} from "../../features/agents/local-activity";
import {
  useTypingReplacement,
  useActivityTypingReplacement,
} from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";
import messageStyles from "../../features/messages/Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { AgentResponsePreview } from "../../features/messages/AgentResponsePreview";

const noSubscribe = () => () => {};
export type ActivityAgents = WorkStopAgents;
type ActivityProps = ComposerAccessoryProps & { agents?: ActivityAgents };
/** Activity belongs to the exact triggering message, not the composer. */
export function ActivityAccessory(props: ActivityProps) {
  const { session, channelId, message, canOpen } = props;
  const messageId = message?.id;
  const recorded = useRecordedActivityAgents(session, channelId, messageId);
  // Every row mounts this; only rows with work subscribe to each activity
  // step, profile and choice change. Others read once and wait for work.
  const hasWork = useSyncExternalStore(session.agentActivity.subscribe, () => {
    if (!messageId) return false;
    const work = messageWork(
      session.agentActivity.snapshot(),
      channelId,
      messageId,
    );
    return work.live.length > 0 || work.stopped.length > 0;
  });
  const snapshot = useSyncExternalStore(
    hasWork ? session.agentActivity.subscribe : noSubscribe,
    session.agentActivity.snapshot,
  );
  const { live: entries, stopped } = useMemo(
    () =>
      messageId && hasWork
        ? messageWork(snapshot, channelId, messageId)
        : { live: [], stopped: [] },
    [snapshot, channelId, messageId, hasWork],
  );
  const profiles = useSyncExternalStore(
    hasWork ? session.profiles.subscribe : noSubscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    hasWork ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = [...entries, ...stopped].map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys, profileGeneration]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        choices.identities.find((row) => row.pubkey === key)?.name ??
        suffixes.get(key) ??
        "Agent",
    ),
  );
  const named = (agent: string) => {
    const name = names[keys.indexOf(agent)] ?? "Agent";
    return names.filter((value) => value === name).length > 1
      ? `${name} · ${suffixes.get(agent)}`
      : name;
  };
  const visible = (entry: RequestWork) => {
    if (!canOpen(profileActivityViewTarget(entry.agent) ?? "")) return false;
    if (
      recorded.has(entry.agent) &&
      entry.state !== "error" &&
      entry.state !== "stopped"
    )
      return false;
    if (props.messageLayout !== "thread" && !message?.threadRootId) {
      const local = (snapshot.local ?? []).filter(
        (work) =>
          work.agent === entry.agent &&
          work.channelId === channelId &&
          work.messageId === messageId,
      );
      if (local.length)
        return local.some(
          (work) =>
            !work.thread &&
            !(
              message &&
              message.replyCount > 0 &&
              work.threadRootId === message.id
            ),
        );
      const turns = activityTranscript(entry.selected.records, {
        agent: entry.agent,
        channelId,
      }).turns;
      if (turns.length && turns.every((turn) => !!turn.threadRootId))
        return false;
    }
    return true;
  };
  const shown: Entry[] = entries
    .filter(
      (entry) =>
        visible(entry) &&
        (entry.stoppable ||
          entry.state === "error" ||
          !props.representedAgents?.includes(entry.agent)),
    )
    .map((entry) => {
      return {
        agent: entry.agent,
        name: named(entry.agent),
        picture: profiles.get(entry.agent)?.picture,
        working: entry.working,
        state: entry.state,
        reason: entry.reason,
        ...(entry.step ? { step: entry.step } : {}),
        ...(entry.stoppable ? { stoppable: true } : {}),
        ...(entry.retryable ? { retryable: true } : {}),
        lifecycle: entry.lifecycle,
        records: entry.selected.records,
        turns: entry.turns,
      };
    });
  // When work ends (not when access is revoked), keep the last bubble long
  // enough for the shared leave recipe, then remove it.
  const section = useRef<HTMLElement>(null);
  const retained = useRef<Entry[]>([]);
  const [leaving, setLeaving] = useState<Entry[] | null>(null);
  const ended = !entries.length;
  useLayoutEffect(() => {
    // Child closes its portal and restores focus before this subtree is inert.
    if (section.current) section.current.inert = !shown.length;
    if (shown.length) {
      retained.current = shown;
      if (leaving) setLeaving(null);
      return;
    }
    if (ended && retained.current.length) setLeaving(retained.current);
    retained.current = [];
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    const animations = section.current?.getAnimations?.() ?? [];
    if (!animations.length) {
      setLeaving(null);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setLeaving(null);
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      done,
      done,
    );
    return () => {
      live = false;
    };
  }, [leaving]);
  // The render where work ends keeps the same element (from the last shown
  // entries) so the list never loses and regains its height mid-handoff.
  const bubble = (
    shown.length ? shown : (leaving ?? (ended ? retained.current : []))
  ).filter(
    (entry) =>
      (!recorded.has(entry.agent) || entry.state === "error") &&
      (entry.stoppable ||
        entry.state === "error" ||
        !props.representedAgents?.includes(entry.agent)),
  );
  // Once its live bubble has left, a stopped request stays noted here.
  const noted = bubble.length ? [] : stopped.filter(visible);
  const note = noted.length ? (
    <div
      className={`${styles.root} ${styles.stopped} text-caption text-subtle buzz-arrive`}
      data-activity-stopped=""
      data-buzz-ui=""
    >
      <AvatarStack
        size="mini"
        items={noted.map(({ agent }) => ({
          id: agent,
          name: named(agent),
          src: avatarMedia(profiles.get(agent)?.picture, session.media),
          shape: "squircle",
        }))}
      />
      <span>{noted.map(({ agent }) => named(agent)).join(", ")} · Stopped</span>
    </div>
  ) : null;
  if (!bubble.length) return note;
  const primary = bubble[0];
  if (!primary) return note;
  return (
    <section
      ref={section}
      className={`${styles.root} buzz-arrive`}
      data-message-activity=""
      data-arrive="grow"
      data-leaving={shown.length ? undefined : ""}
      data-buzz-ui=""
      aria-label="Agent activity on this message"
      aria-hidden={shown.length ? undefined : true}
    >
      <AgentResponsePreview
        name={primary.name}
        participants={bubble.map((entry) => ({
          id: entry.agent,
          name: entry.name,
          picture: avatarMedia(entry.picture, session.media),
        }))}
        picture={avatarMedia(primary.picture, session.media)}
        layout={props.messageLayout}
      >
        {shown.map((entry) => (
          <TypingReplacement
            shared
            key={entry.agent}
            {...props}
            agent={entry.agent}
          />
        ))}
        <ActivityBubble
          key={`${channelId}:${message?.id ?? ""}`}
          {...props}
          entries={bubble}
          interactive={shown.length > 0}
        />
      </AgentResponsePreview>
    </section>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  state: RequestWork["state"];
  reason: string | undefined;
  step?: WorkStep;
  stoppable?: boolean;
  retryable?: boolean;
  lifecycle: boolean;
  records: ReturnType<typeof activityRecords>;
  turns: readonly ActivityTurn[];
};

function ActivityBubble({
  entries,
  interactive,
  agents,
  ...props
}: ActivityProps & { entries: Entry[]; interactive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const message = props.message;
  const controls = new Map(
    entries.flatMap((entry) => {
      const control =
        message &&
        workStop(
          entry,
          {
            channelId: props.channelId,
            messageId: message.id,
            threadRootId: message.threadRootId ?? message.id,
          },
          props.session.agentActivity,
          agents,
        );
      return control ? [[entry.agent, control] as const] : [];
    }),
  );
  const { pending: stops, stop } = useWorkStops([...controls.values()]);
  const notify = useToastNotification();
  // A retried request begins again; its popup closes on the new row.
  const retry = (entry: Entry) => {
    if (!message) return;
    try {
      props.session.agentActivity.retry(
        entry.agent,
        props.channelId,
        message.id,
      );
      setExpanded(false);
    } catch (error) {
      notify(
        `Couldn’t retry ${entry.name}. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const retirement = useRef({
    interactive,
    onFocusedRemoval: props.onFocusedRemoval,
  });
  useLayoutEffect(() => {
    retirement.current = {
      interactive,
      onFocusedRemoval: props.onFocusedRemoval,
    };
  });
  useLayoutEffect(
    () => () => {
      // Published content removes this preview immediately, without a leave phase.
      // Ordinary completion uses the existing interactive=false handoff below.
      if (!retirement.current.interactive) return;
      const focused = trigger.current?.ownerDocument.activeElement;
      if (
        focused &&
        (trigger.current?.contains(focused) || popup.current?.contains(focused))
      )
        retirement.current.onFocusedRemoval?.();
    },
    [],
  );
  useLayoutEffect(() => {
    if (interactive) return;
    const source = popup.current;
    const button = trigger.current;
    const document = (source ?? button)?.ownerDocument;
    const active = document?.activeElement;
    setExpanded(false);
    if (active && (button?.contains(active) || source?.contains(active))) {
      // Commit closure before handing off: its overlay currently hides the
      // host's target. DOM observers release that target at this checkpoint.
      // Keep the retired nodes so unmount does not erase focus ownership.
      queueMicrotask(() => {
        const current = document?.activeElement;
        if (
          current === document?.body ||
          (current && (button?.contains(current) || source?.contains(current)))
        )
          props.onFocusedRemoval?.();
      });
    }
  }, [interactive, props.onFocusedRemoval]);
  const working = entries.some((entry) => entry.working);
  // Local work breathes until its first step ("Starting"), like the sidebar and thread.
  const starting = (entry: Entry) =>
    entry.lifecycle &&
    (entry.state === "waiting" || (entry.state === "working" && !entry.step));
  const waiting = entries.some(starting);
  const stepping = entries.some((entry) => entry.working && !starting(entry));

  const unknown = entries.some((entry) => !entry.lifecycle && !entry.working);
  const failedCount = entries.filter(
    (entry) => entry.lifecycle && entry.state === "error",
  ).length;
  const label = (entry: Entry) =>
    entry.lifecycle
      ? localWorkLabel({
          state:
            entry.state === "ended"
              ? "done"
              : entry.state === "unknown"
                ? "error"
                : entry.state,
          ...(entry.reason ? { error: entry.reason } : {}),
          ...(entry.step ? { step: entry.step } : {}),
        })
      : entry.working
        ? "working"
        : "status unknown";
  const failedEntries = entries.filter(
    (entry) => entry.lifecycle && entry.state === "error",
  );
  const otherEntries = entries.filter(
    (entry) => !failedEntries.includes(entry),
  );
  const current =
    otherEntries.find((entry) => entry.working && entry.step) ??
    otherEntries.find((entry) => entry.working);
  const currentPreview =
    current && !current.lifecycle
      ? currentActivity(current.records, current.turns)
      : undefined;
  const stepText = current?.step
    ? label(current)
    : currentPreview
      ? [currentPreview.title, currentPreview.detail]
          .filter(Boolean)
          .join(" · ")
      : undefined;
  const avatars = (group: Entry[]) => (
    <AvatarStack
      size="mini"
      items={group.map((entry) => ({
        id: entry.agent,
        name: entry.name,
        src: avatarMedia(entry.picture, props.session.media),
        shape: "squircle",
      }))}
    />
  );
  const content = (
    <span className={styles.summaryGroups}>
      {otherEntries.length > 0 && (
        <span className={styles.summaryActivity} data-thread-working="">
          {(working || waiting) && (
            <ActivityStepPreview
              text={stepText}
              state={stepping ? "working" : "waiting"}
            />
          )}
          {unknown && <span>Status unknown</span>}
        </span>
      )}
      {failedCount > 0 && (
        <span
          className={`${styles.summaryActivity} ${styles.failure}`}
          data-activity-failure=""
        >
          {avatars(
            failedEntries.filter((entry) => entry.agent !== entries[0]?.agent),
          )}
          <WarningCircleIcon size={12} aria-hidden="true" />
          <span>{failedCount} failed</span>
        </span>
      )}
    </span>
  );
  if (!entries.length) return null;
  return (
    <PopoverRoot
      open={expanded}
      onOpenChange={(open) => setExpanded(interactive && open)}
    >
      <PopoverTrigger
        openOnHover={interactive && "preview"}
        {...(!interactive
          ? {
              "aria-haspopup": undefined,
              "aria-expanded": undefined,
              "aria-controls": undefined,
            }
          : {})}
        onClick={(event) => {
          if (!interactive) {
            event.preventBaseUIHandler();
            return;
          }
        }}
        render={
          <button
            ref={trigger}
            tabIndex={interactive ? undefined : -1}
            type="button"
            className={messageStyles.activityBubbleTrigger}
            data-activity-summary=""
            aria-label={`View agent activity: ${entries.map((entry) => `${entry.name}, ${label(entry)}`).join("; ")}`}
          >
            {content}
          </button>
        }
      />
      <PopoverPopup
        ref={popup}
        finalFocus={interactive ? undefined : false}
        side="top"
        padding="list"
        aria-label="Agent activity"
      >
        {expanded && (
          <div className={styles.previews}>
            <NavigationItem
              variant="option"
              label="Activity"
              aria-label="View full activity"
              trailing={<ArrowUpRightIcon aria-hidden="true" />}
              disabled={
                !entries[0] ||
                !props.canOpen(
                  profileActivityViewTarget(entries[0].agent, {
                    transcript: true,
                  }) ?? "",
                )
              }
              onClick={() => {
                const target =
                  entries[0] &&
                  profileActivityViewTarget(entries[0].agent, {
                    transcript: true,
                  });
                if (
                  target &&
                  props.canOpen(target) &&
                  openProfileTranscript(target, props.open)
                )
                  setExpanded(false);
              }}
            />
            {entries.map((entry) => {
              // Opens the agent's profile on its Activity tab.
              const target = profileActivityViewTarget(entry.agent);
              const preview = entry.working
                ? currentActivity(entry.records, entry.turns)
                : undefined;
              const control = controls.get(entry.agent);
              const stopping = !!control && stops.has(control.key);
              return (
                <NavigationCard key={entry.agent}>
                  <NavigationItem
                    variant="option"
                    aria-label={`View activity for ${entry.name}`}
                    disabled={!target || !props.canOpen(target)}
                    onClick={() => {
                      if (target && props.canOpen(target) && props.open(target))
                        setExpanded(false);
                    }}
                    icon={
                      <ActivityAvatar
                        session={props.session}
                        entry={entry}
                        size="small"
                      />
                    }
                    label={
                      <span
                        className={`text-body-sm ${styles.preview}`}
                        data-error={
                          entry.lifecycle && entry.state === "error"
                            ? ""
                            : undefined
                        }
                      >
                        <ShimmerText
                          active={stopping || entry.working || starting(entry)}
                        >
                          {(stopping ? "Stopping…" : undefined) ??
                            (entry.lifecycle
                              ? label(entry)
                              : !entry.working
                                ? "Activity interrupted or out of date"
                                : (preview?.title ??
                                  "Waiting for activity details"))}
                        </ShimmerText>
                        {preview?.detail && (
                          <span className={styles.detail}>
                            <ShimmerText active={entry.working}>
                              {preview.detail}
                            </ShimmerText>
                          </span>
                        )}
                      </span>
                    }
                  />
                  {entry.lifecycle && entry.state === "error" ? (
                    <span className={styles.action}>
                      {entry.retryable && (
                        <Button
                          size="sm"
                          variant="subtle"
                          aria-label={`Retry ${entry.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            retry(entry);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Dismiss error from ${entry.name}`}
                        icon={<XIcon />}
                        onClick={(event) => {
                          event.stopPropagation();
                          // Retirement owns the last popup's close and focus
                          // handoff; keep its focused contents until that effect.
                          if (props.message)
                            props.session.agentActivity.dismissError?.(
                              entry.agent,
                              props.channelId,
                              props.message.id,
                            );
                        }}
                      />
                    </span>
                  ) : control ? (
                    <span className={styles.action}>
                      <Button
                        size="sm"
                        variant="plain"
                        aria-label={`Stop ${entry.name}`}
                        loading={stopping}
                        onClick={(event) => {
                          event.stopPropagation();
                          stop(control, entry.name);
                        }}
                      >
                        <OctagonIcon
                          className={styles.stopIcon}
                          aria-hidden="true"
                        />
                        <span>Stop</span>
                      </Button>
                    </span>
                  ) : undefined}
                </NavigationCard>
              );
            })}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Message-linked work replaces the composer control; unassociated work keeps
 * main's existing presentation rather than disappearing without a bubble. */
export function ActivityTypingReplacement(props: ComposerAccessoryProps) {
  // Subscribe to which agents are replaced, not every observer frame.
  const agents = useSyncExternalStore(
    props.session.agentActivity.subscribe,
    () => replacedAgents(props),
  );
  return (
    <>
      {agents
        .split(",")
        .filter(Boolean)
        .map((agent) => (
          <TypingReplacement key={agent} {...props} agent={agent} />
        ))}
    </>
  );
}
function replacedAgents(props: ComposerAccessoryProps) {
  const activity = props.session.agentActivity.snapshot();
  const ids = [
    ...(props.threadRootId ? [props.threadRootId] : []),
    ...(activity.local ?? [])
      .filter(
        (request) =>
          request.channelId === props.channelId &&
          (!props.threadRootId ||
            (request.threadRootId ?? request.messageId) === props.threadRootId),
      )
      .map((request) => request.messageId),
    ...activity.turns.flatMap((turn) =>
      turn.channelId === props.channelId
        ? (turn.requests ?? [])
            .filter(
              (request) =>
                !props.threadRootId ||
                request.threadRootId === props.threadRootId,
            )
            .map((request) => request.messageId)
        : [],
    ),
  ];
  return requestWork(activity, props.channelId, ids)
    .map(({ agent }) => agent)
    .join(",");
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  agent,
  shared = false,
}: ComposerAccessoryProps & { agent: string; shared?: boolean }) {
  useActivityTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    shared,
  );
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    true,
  );
  return null;
}

function ActivityAvatar({
  session,
  entry,
  size = "compact",
}: Pick<ComposerAccessoryProps, "session"> & {
  entry: Entry;
  size?: "compact" | "small";
}) {
  return (
    <Avatar
      src={avatarMedia(entry.picture, session.media)}
      alt={entry.name}
      fallback={entry.name}
      size={size}
      shape="squircle"
    />
  );
}
