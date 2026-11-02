import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { canMessageAgent } from "../agents/choices";
import type { RelaySession } from "../relay/session";

const noSubscribe = () => () => {};

/** Shared profile action: respect community agent readiness and retire stale opens. */
export function useProfileMessage({
  session,
  pubkey,
  viewer,
  agent,
  enabled,
  onOpened,
}: {
  session: RelaySession | undefined;
  pubkey: string;
  viewer: string | undefined;
  agent: boolean;
  enabled: boolean;
  onOpened(channelId: string): void;
}) {
  const attempt = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const messageable = () =>
    enabled &&
    (!agent ||
      !!session?.agentChoices
        .snapshot()
        .identities.some(
          (choice) => canMessageAgent(choice) && choice.pubkey === pubkey,
        ));
  const ready = useSyncExternalStore(
    enabled && agent
      ? (session?.agentChoices.subscribe ?? noSubscribe)
      : noSubscribe,
    messageable,
    messageable,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Session, identity, and preview visibility retire the pending action.
  useEffect(() => {
    setOpening(false);
    setError("");
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [session, pubkey, viewer, enabled]);
  const available =
    enabled &&
    !!session?.directMessages.available &&
    !!viewer &&
    viewer !== pubkey &&
    ready;
  async function open() {
    if (!available || !session || attempt.current || !messageable()) return;
    const controller = new AbortController();
    attempt.current = controller;
    setOpening(true);
    setError("");
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (!controller.signal.aborted) onOpened(channelId);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      if (attempt.current === controller) attempt.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  }
  return { available, opening, error, open };
}
