import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import type { ComposerSession } from "./composer-session";

/** The conversation whose composer, a following sibling of this history, shows activity. */
export type ActivityLane = Readonly<{
  session: ComposerSession;
  channelId: string;
  threadRootId?: string | undefined;
}>;

// The composer's TypingIndicator publishes whether it shows working agents; the
// history's jump button reads it. Deriving the pill twice would miss the
// composer's replacement context and subscribe the button to every typing
// tick. Mounted presentation only: no data, timers, or reads.
type Lane = { shown: number; listeners: Set<() => void> };
const lanes = new WeakMap<ComposerSession, Map<string, Lane>>();
const key = (channelId: string, threadRootId: string | undefined) =>
  `${channelId}\n${threadRootId ?? ""}`;
function lane(
  session: ComposerSession,
  channelId: string,
  threadRootId: string | undefined,
) {
  const byKey = lanes.get(session) ?? new Map<string, Lane>();
  lanes.set(session, byKey);
  const id = key(channelId, threadRootId);
  const entry = byKey.get(id) ?? { shown: 0, listeners: new Set<() => void>() };
  byKey.set(id, entry);
  return entry;
}
function release(entry: Lane, session: ComposerSession, id: string) {
  if (entry.shown === 0 && entry.listeners.size === 0)
    lanes.get(session)?.delete(id);
}

/** Publish, while `shown`, that this conversation's composer shows working agents. */
export function useActivityLanePublisher(
  session: ComposerSession,
  channelId: string,
  threadRootId: string | undefined,
  shown: boolean,
) {
  useLayoutEffect(() => {
    if (!shown) return;
    const entry = lane(session, channelId, threadRootId);
    entry.shown += 1;
    for (const listener of entry.listeners) listener();
    return () => {
      entry.shown -= 1;
      for (const listener of entry.listeners) listener();
      release(entry, session, key(channelId, threadRootId));
    };
  }, [session, channelId, threadRootId, shown]);
}

const noSubscribe = () => () => {};
const notShown = () => false;
/** Whether a mounted composer shows working agents in the lane's conversation. */
export function useActivityLaneShown(target: ActivityLane | undefined) {
  const session = target?.session;
  const channelId = target?.channelId;
  const threadRootId = target?.threadRootId;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!session || channelId === undefined) return noSubscribe();
      const entry = lane(session, channelId, threadRootId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        release(entry, session, key(channelId, threadRootId));
      };
    },
    [session, channelId, threadRootId],
  );
  const snapshot = useCallback(
    () =>
      !!session &&
      channelId !== undefined &&
      (lanes.get(session)?.get(key(channelId, threadRootId))?.shown ?? 0) > 0,
    [session, channelId, threadRootId],
  );
  return useSyncExternalStore(subscribe, snapshot, notShown);
}
