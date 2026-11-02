import { useLayoutEffect, useRef } from "react";

/** Only user edits call this; there is no heartbeat or deferred retry. */
export function useTypingBroadcast(
  send:
    | ((
        channelId: string,
        rootId: string | undefined,
        signal: AbortSignal,
      ) => Promise<void>)
    | undefined,
  channelId: string,
  threadRootId: string | undefined,
  enabled: boolean,
) {
  const lifetime = useRef<AbortController | undefined>(undefined);
  const lastSent = useRef(-Infinity);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope and writability changes cancel outstanding ephemeral publication.
  useLayoutEffect(() => {
    lifetime.current = undefined;
    lastSent.current = -Infinity;
    if (!enabled || !send) return;
    const owner = new AbortController();
    lifetime.current = owner;
    return () => owner.abort();
  }, [send, channelId, threadRootId, enabled]);
  return () => {
    const signal = lifetime.current?.signal;
    const now = performance.now();
    if (
      !enabled ||
      !send ||
      !signal ||
      signal.aborted ||
      now - lastSent.current < 3_000
    )
      return;
    lastSent.current = now;
    // Ephemeral failure must not interrupt editing or become a durable send.
    void send(channelId, threadRootId, signal).catch(() => {});
  };
}
