import { useProfileGeneration } from "../../features/relay/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { attestedOwner } from "../../features/agents/owner-attestation";
import { type EventData, newer } from "../../features/relay/events";
import type {
  EventViewSnapshot,
  RelaySession,
} from "../../features/relay/session";

const pending: EventViewSnapshot = { status: "idle", events: [] };
const noSubscribe = () => () => {};
const pendingSnapshot = () => pending;

/** Public attribution only. One live view for the dialog, not one per row. */
export function useMemberOwners(
  session: RelaySession,
  keys: string,
  attempt: number,
) {
  const [observation, setObservation] = useState<{
    session: RelaySession;
    keys: string;
    attempt: number;
    view: ReturnType<RelaySession["observe"]> | null;
  }>();
  const view =
    observation?.session === session &&
    observation.keys === keys &&
    observation.attempt === attempt
      ? observation.view
      : undefined;
  useEffect(() => {
    if (!keys) {
      setObservation({ session, keys, attempt, view: null });
      return;
    }
    try {
      const owned = session.observe([
        { kinds: [0], authors: keys.split(":"), limit: 500 },
      ]);
      setObservation({ session, keys, attempt, view: owned });
      return owned.dispose;
    } catch {
      setObservation({ session, keys, attempt, view: null });
    }
  }, [session, keys, attempt]);
  const events = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.snapshot ?? pendingSnapshot,
    view?.snapshot ?? pendingSnapshot,
  );
  useEffect(() => {
    if (events.status === "idle") void view?.refresh();
  }, [view, events.status]);
  // Listen to signed-head changes even when display fields are identical.
  const heads = useSyncExternalStore(
    session.profiles.subscribe,
    () =>
      keys
        .split(":")
        .map((key) => session.profiles.event?.(key)?.id ?? "")
        .join(":"),
    () => "",
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: heads invalidates retained signed events, not profile projections.
  const latest = useMemo(() => {
    const result = new Map<string, EventData>();
    if (!view) return result;
    const requested = new Set(keys.split(":"));
    for (const key of requested) {
      const head = session.profiles.event?.(key);
      if (head) result.set(key, head);
    }
    for (const event of events.events) {
      if (
        event.kind === 0 &&
        event.delivery !== "failed" &&
        requested.has(event.pubkey)
      )
        result.set(event.pubkey, newer(result.get(event.pubkey), event));
    }
    return result;
  }, [view, session, keys, heads, events.events]);
  const [verified, setVerified] = useState(
    new Map<string, { id: string; owner: string | undefined }>(),
  );
  // Filtering changes the observed set, not the signed evidence. Retain one
  // verification per identity/head for this dialog; refresh/session changes retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session and attempt bound the verification lifetime.
  const checks = useMemo(
    () => new Map<string, { id: string; owner: Promise<string | undefined> }>(),
    [session, attempt],
  );
  useEffect(() => {
    let active = true;
    void Promise.all(
      [...latest].map(async ([key, event]) => {
        let check = checks.get(key);
        if (check?.id !== event.id) {
          check = { id: event.id, owner: attestedOwner(event) };
          checks.set(key, check);
        }
        return [key, { id: event.id, owner: await check.owner }] as const;
      }),
    ).then((next) => {
      if (active) setVerified(new Map(next));
    });
    return () => {
      active = false;
    };
  }, [latest, checks]);
  const owners = new Map<string, string>();
  for (const [key, event] of latest) {
    const evidence = verified.get(key);
    if (evidence?.id === event.id && evidence.owner)
      owners.set(key, evidence.owner);
  }
  const ownerKeys = [...new Set(owners.values())].sort().join(":");
  const [names, setNames] = useState<{
    session: RelaySession;
    keys: string;
    attempt: number;
    busy: boolean;
    failed: boolean;
  }>();
  const currentNames =
    names?.session === session &&
    names.keys === ownerKeys &&
    names.attempt === attempt
      ? names
      : undefined;
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    let active = true;
    setNames({
      session,
      keys: ownerKeys,
      attempt,
      busy: !!ownerKeys,
      failed: false,
    });
    if (ownerKeys)
      void session.profiles.ensure(ownerKeys.split(":"), "background").then(
        () => {
          if (active)
            setNames({
              session,
              keys: ownerKeys,
              attempt,
              busy: false,
              failed: false,
            });
        },
        () => {
          if (active)
            setNames({
              session,
              keys: ownerKeys,
              attempt,
              busy: false,
              failed: true,
            });
        },
      );
    return () => {
      active = false;
    };
  }, [session, ownerKeys, attempt, profileGeneration]);
  return {
    owners,
    busy:
      !!keys &&
      (view === undefined ||
        (!!view && (events.status === "idle" || events.status === "loading")) ||
        [...latest].some(
          ([key, event]) => verified.get(key)?.id !== event.id,
        ) ||
        (!!ownerKeys && (!currentNames || currentNames.busy))),
    failed:
      !!keys &&
      (view === null || events.status === "error" || !!currentNames?.failed),
  };
}
