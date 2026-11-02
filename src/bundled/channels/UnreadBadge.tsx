import { Button } from "../../shared/design-system/ui/Button";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Channels.module.css";

type UnreadSnapshot = ReturnType<RelaySession["unread"]["snapshot"]>;

/** Bold tracks ordinary backlog; protected attention has its own dot. */
export function ordinaryUnread(snapshot: UnreadSnapshot, dm: boolean) {
  const count = snapshot.observedCount ?? 0;
  return (
    snapshot.manual !== "none" ||
    (dm ? count > 0 : count > (snapshot.attentionCount ?? 0))
  );
}

/** Unread evidence for one channel's badge. */
export function useUnreadState(
  session: RelaySession,
  channelId: string,
  dm: boolean,
) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const subscribeActivity = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const getActivity = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const activity = useSyncExternalStore(
    subscribeActivity,
    getActivity,
    getActivity,
  );
  const count = snapshot.observedCount;
  const manual = snapshot.manual !== "none";
  const unread = manual || (count ?? 0) > 0;
  const ordinary = ordinaryUnread(snapshot, dm);
  const threadCount = activity.items?.length ?? 0;
  return { snapshot, activity, count, manual, unread, ordinary, threadCount };
}

export function UnreadBadge({
  session,
  channelId,
  dm = false,
  label,
  labelUnread = "ordinary",
}: {
  session: RelaySession;
  channelId: string;
  dm?: boolean;
  label?: ReactNode;
  /** Solo labels emphasize every unread message, so attention adds no dot. */
  labelUnread?: "ordinary" | "all";
}) {
  const { snapshot, activity, count, manual, unread, ordinary, threadCount } =
    useUnreadState(session, channelId, dm);
  if (!unread && !threadCount && label === undefined) return null;
  const priority = dm || (snapshot.attentionCount ?? 0) > 0;
  const showUnreadDot =
    priority && threadCount === 0 && labelUnread === "ordinary";
  const unreadLabel = manual
    ? `Marked unread${snapshot.manual === "local-only" ? " on this device only" : ""}`
    : `${count} observed unread messages${snapshot.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`;
  const threadLabel = `${threadCount} unread ${threadCount === 1 ? "thread" : "threads"}${activity.freshness === "stale" ? "; may be out of date" : ""}`;
  return (
    <>
      {label !== undefined && (
        <span
          data-channel-unread-title={
            (labelUnread === "all" ? unread : ordinary) || undefined
          }
        >
          {label}
        </span>
      )}
      {unread && (
        <span
          className={styles.unreadState}
          data-channel-unread=""
          data-priority={priority}
          role="img"
          aria-label={unreadLabel}
        />
      )}
      {showUnreadDot && (
        <span
          className={styles.priorityDot}
          data-channel-priority=""
          data-indicator-layer="unread"
          aria-hidden="true"
        />
      )}
      {threadCount > 0 && (
        <span
          className={styles.threadActivityDot}
          data-channel-activity=""
          role="img"
          aria-label={threadLabel}
          title={threadLabel}
        />
      )}
    </>
  );
}
export function UnreadOptions({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId?: string | undefined;
}) {
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [error, setError] = useState<string>();
  const run = (operation: Promise<unknown>) => {
    setError(undefined);
    void operation.catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Read-state operation failed",
      ),
    );
  };
  return (
    <>
      {channelId && (
        <Button
          type="button"
          onClick={() =>
            run(session.unread.markUnreadLocal({ kind: "channel", channelId }))
          }
        >
          Mark unread on this device
        </Button>
      )}
      {channelId && sync.capability === "frontier-sync" && (
        <Button
          type="button"
          onClick={() => {
            const last = session.channels
              .window(channelId)
              .rows.filter((row) => !row.membership && !row.huddle)
              .at(-1);
            if (last)
              run(
                session.unread.markThrough(
                  { kind: "channel", channelId },
                  last.id,
                ),
              );
            else setError("Load a verified message before marking through it.");
          }}
        >
          Mark read through loaded messages
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Unread status</summary>
        <p>
          Observed messages only—not exact totals. Manual unread is local to
          this device. Older read hints can expire; this is not an everlasting
          read receipt log.
        </p>
        <p>
          Read sync: {sync.capability} · {sync.status}
        </p>
        {sync.error && <p role="alert">{sync.error}</p>}
        <Button type="button" onClick={() => run(session.unread.refresh())}>
          Refresh unread observations
        </Button>
        {sync.capability === "frontier-sync" && (
          <Button type="button" onClick={() => run(session.unread.retrySync())}>
            Retry read sync
          </Button>
        )}
      </details>
    </>
  );
}
