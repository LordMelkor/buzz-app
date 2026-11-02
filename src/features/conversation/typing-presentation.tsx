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
export function useTypingReplacement(value: Replacement, enabled: boolean) {
  const context = useContext(Presentation);
  const store = context?.store;
  const active = context?.active;
  const { session, channelId, threadRootId, pubkey } = value;
  useLayoutEffect(() => {
    if (active && enabled)
      return store?.register({
        session,
        channelId,
        threadRootId,
        pubkey,
      });
  }, [store, active, enabled, session, channelId, threadRootId, pubkey]);
}
export function useReplacedTypers(
  session: object | undefined,
  channelId: string,
  threadRootId: string | undefined,
) {
  const context = useContext(Presentation);
  const entries = useSyncExternalStore(
    context?.store.subscribe ?? noopSubscribe,
    context?.store.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return useMemo(
    () =>
      new Set(
        context?.active
          ? entries
              .filter(
                (entry) =>
                  entry.session === session &&
                  entry.channelId === channelId &&
                  entry.threadRootId === threadRootId,
              )
              .map((entry) => entry.pubkey)
          : [],
      ),
    [context?.active, entries, session, channelId, threadRootId],
  );
}
