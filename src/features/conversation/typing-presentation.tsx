import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";

type Replacement = Readonly<{
  session: RelaySession;
  channelId: string;
  threadRootId: string | undefined;
  pubkey: string;
  requestId?: string | undefined;
}>;
function createPresentation() {
  const entries = new Map<symbol, Replacement>();
  const listeners = new Set<() => void>();
  let snapshot: readonly Replacement[] = [];
  const publish = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(value: Replacement) {
      const token = Symbol();
      entries.set(token, value);
      publish();
      return () => {
        if (entries.delete(token)) publish();
      };
    },
  };
}
const Presentation = createContext<
  | {
      store: ReturnType<typeof createPresentation>;
      active: boolean;
    }
  | undefined
>(undefined);
const empty: readonly Replacement[] = [];
const emptySnapshot = () => empty;
const noopSubscribe = () => () => {};

/** Mounted conversation presentation only; no data, timers, or plugin identity checks. */
export function TypingPresentation({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [store] = useState(createPresentation);
  const value = useMemo(() => ({ store, active }), [store, active]);
  return (
    <Presentation.Provider value={value}>{children}</Presentation.Provider>
  );
}
export function useTypingReplacement(
  value: Replacement | undefined,
  enabled: boolean,
) {
  useReplacement(useContext(Presentation), value, enabled);
}
const ActivityPresentation = createContext<
  ReturnType<typeof createPresentation> | undefined
>(undefined);
export function ActivityIndicatorPresentation({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(createPresentation);
  return (
    <ActivityPresentation.Provider value={store}>
      {children}
    </ActivityPresentation.Provider>
  );
}
export function useActivityTypingReplacement(
  value: Replacement | undefined,
  enabled: boolean,
  participants?: readonly string[],
) {
  const store = useContext(ActivityPresentation);
  useReplacement(
    store ? { store, active: true } : undefined,
    value,
    enabled,
    participants,
  );
}
function useReplacement(
  context:
    | { store: ReturnType<typeof createPresentation>; active: boolean }
    | undefined,
  value: Replacement | undefined,
  enabled: boolean,
  participants?: readonly string[],
) {
  const store = context?.store;
  const active = context?.active;
  const { session, channelId, threadRootId, pubkey, requestId } = value ?? {};
  const participantKeys = (participants ?? (pubkey ? [pubkey] : [])).join(":");
  useLayoutEffect(() => {
    if (!active || !enabled || !session || !channelId || !participantKeys)
      return;
    const releases = participantKeys.split(":").map((pubkey) =>
      store?.register({
        session,
        channelId,
        threadRootId,
        pubkey,
        requestId,
      }),
    );
    return () => {
      for (const release of releases) release?.();
    };
  }, [
    store,
    active,
    enabled,
    session,
    channelId,
    threadRootId,
    participantKeys,
    requestId,
  ]);
}
export function useReplacedTypers(
  session: object | undefined,
  channelId: string,
  threadRootId: string | undefined,
) {
  const context = useContext(Presentation);
  const activityStore = useContext(ActivityPresentation);
  const activityEntries = useSyncExternalStore(
    activityStore?.subscribe ?? noopSubscribe,
    activityStore?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const entries = useSyncExternalStore(
    context?.store.subscribe ?? noopSubscribe,
    context?.store.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return useMemo(
    () =>
      new Set(
        [...(context?.active ? entries : []), ...activityEntries]
          .filter(
            (entry) =>
              !entry.requestId &&
              entry.session === session &&
              entry.channelId === channelId &&
              entry.threadRootId === threadRootId,
          )
          .map((entry) => entry.pubkey),
      ),
    [
      context?.active,
      entries,
      activityEntries,
      session,
      channelId,
      threadRootId,
    ],
  );
}

/** Recorded history owns request controls only while that history is mounted. */
export function useRecordedActivityAgents(
  session: object,
  channelId: string,
  requestId: string | undefined,
) {
  const store = useContext(ActivityPresentation);
  const entries = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.session === session &&
          entry.channelId === channelId &&
          !!requestId &&
          entry.requestId === requestId,
      )
      .map((entry) => entry.pubkey),
  );
}
