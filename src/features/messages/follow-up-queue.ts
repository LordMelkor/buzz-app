import type { RelaySession } from "../relay/session";

type Activity = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Wait = { agent: string; message?: string; turn?: string };
type Entry = {
  id: string;
  channelId: string;
  text: string;
  recipients: readonly string[];
  publish(): string;
  beforeRelease?(): Promise<void>;
  onSend?(id: string): void;
  error?: string;
};
const queues = new WeakMap<RelaySession, ReturnType<typeof createQueue>>();

/** Session-local pending sends survive navigation, like background uploads. */
export function followUpQueue(session: RelaySession) {
  let queue = queues.get(session);
  if (!queue) {
    queue = createQueue(session);
    queues.set(session, queue);
  }
  return queue;
}

function createQueue(session: RelaySession) {
  let entries: readonly Entry[] = [];
  const waits = new Map<string, Wait[]>();
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publishing = new Set<string>();
  const requested = new Set<string>();
  let activating = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  function finished(wait: Wait, activity: Activity) {
    if (wait.message) {
      const local = activity.local?.find(
        (row) => row.agent === wait.agent && row.messageId === wait.message,
      );
      if (local)
        return (
          local.state === "done" ||
          local.state === "error" ||
          local.state === "superseded" ||
          local.state === "stopped"
        );
      const turns = activity.turns.filter(
        (turn) =>
          turn.agent === wait.agent &&
          turn.requests?.some((request) => request.messageId === wait.message),
      );
      return turns.length > 0 && turns.every((turn) => turn.state === "ended");
    }
    return activity.turns.some(
      (turn) =>
        turn.agent === wait.agent &&
        turn.turnId === wait.turn &&
        turn.state === "ended",
    );
  }
  function blockers(channelId: string) {
    const activity = session.agentActivity?.snapshot();
    let current = waits.get(channelId) ?? [];
    if (activity) {
      current = current.filter((wait) => !finished(wait, activity));
      const local = (activity.local ?? []).filter(
        (row) => row.channelId === channelId,
      );
      for (const row of local) {
        if (row.state === "working" || row.state === "waiting")
          current.push({ agent: row.agent, message: row.messageId });
      }
      for (const turn of activity.turns) {
        if (turn.channelId === channelId && turn.state === "working")
          current.push({ agent: turn.agent, turn: turn.turnId });
      }
    }
    current = [
      ...new Map(current.map((wait) => [JSON.stringify(wait), wait])).values(),
    ];
    if (current.length) waits.set(channelId, current);
    else waits.delete(channelId);
    return (
      current.length > 0 ||
      (session.typing?.snapshot() ?? []).some(
        (entry) =>
          entry.channelId === channelId &&
          !entry.threadRootId &&
          session.agentChoices
            ?.snapshot()
            .identities.some((agent) => agent.pubkey === entry.pubkey),
      ) ||
      (activity?.typing ?? []).some(
        (entry) => entry.channelId === channelId && !entry.threadRootId,
      ) ||
      (!!activity &&
        activity.status !== "listening" &&
        activity.status !== "unavailable")
    );
  }
  function watch() {
    if (stop) return;
    activating = true;
    const unsubscribe = session.agentActivity.subscribe(pump);
    const deactivate = session.agentActivity.activate();
    const offTyping = session.typing?.subscribe(pump);
    const offChoices = session.agentChoices?.subscribe(pump);
    const offChannels = session.channels.subscribeList?.(() => {
      const roster = session.channels.list();
      // The store retains channels on ordinary loading/read failures. Confirmed
      // denial removes them even when list status is error; cached membership
      // alone does not establish revocation.
      const retired = new Set(
        [...waits.keys(), ...entries.map((entry) => entry.channelId)].filter(
          (id) => {
            const channel = roster.channels.find((row) => row.id === id);
            return !channel || (channel.readOnly && !channel.cached);
          },
        ),
      );
      if (!retired.size) return;
      entries = entries.filter((entry) => !retired.has(entry.channelId));
      for (const id of retired) waits.delete(id);
      emit();
      pump();
    });
    const offDismiss = session.outbox?.observeDismiss((item) => {
      if (item.delivery !== "failed") return;
      for (const [channelId, current] of waits) {
        const remaining = current.filter(
          (wait) => wait.message !== item.event.id,
        );
        if (remaining.length) waits.set(channelId, remaining);
        else waits.delete(channelId);
      }
      pump();
    });
    const offRemoval = session.channelLifecycle?.observeRemoval((channelId) => {
      entries = entries.filter((entry) => entry.channelId !== channelId);
      waits.delete(channelId);
      emit();
      pump();
    });
    stop = () => {
      unsubscribe();
      offTyping?.();
      offChoices?.();
      offChannels?.();
      offDismiss?.();
      offRemoval?.();
      deactivate();
    };
    activating = false;
  }
  function sent(entry: Omit<Entry, "id">) {
    const id = entry.publish();
    // Include the gap between publication and the first working signal.
    waits.set(entry.channelId, [
      ...(waits.get(entry.channelId) ?? []),
      ...entry.recipients.map((agent) => ({ agent, message: id })),
    ]);
    watch();
    return id;
  }
  async function release(entry: Entry) {
    if (publishing.has(entry.id)) return;
    publishing.add(entry.id);
    let id: string | undefined;
    try {
      if (entry.beforeRelease) await entry.beforeRelease();
      if (!entries.includes(entry)) return;
      if (!requested.has(entry.id) && blockers(entry.channelId)) return;
      id = sent(entry);
      entries = entries.filter((item) => item !== entry);
    } catch (error) {
      entries = entries.map((item) =>
        item === entry
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    } finally {
      publishing.delete(entry.id);
      requested.delete(entry.id);
      emit();
      queueMicrotask(pump);
    }
    // Presentation failures cannot put an already accepted message back in queue.
    if (id) entry.onSend?.(id);
  }
  function pump() {
    if (activating) return;
    for (const channelId of new Set([
      ...waits.keys(),
      ...entries.map((entry) => entry.channelId),
    ])) {
      if (
        entries.some(
          (entry) => entry.channelId === channelId && publishing.has(entry.id),
        )
      )
        continue;
      if (blockers(channelId)) continue;
      const first = entries.find((entry) => entry.channelId === channelId);
      if (first && !first.error) release(first);
    }
    if (!entries.length && !waits.size) {
      const dispose = stop;
      stop = undefined;
      dispose?.();
    }
  }
  return {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** `validated` means the caller checked recipients just now; only a later release revalidates. */
    submit(entry: Omit<Entry, "id">, validated = false) {
      // Upload completion can arrive after the removal notification, even before
      // this queue exists. Reject before allocating a slot so upload recovery runs.
      if (
        !session.channels
          .list()
          .channels.some(
            (row) =>
              row.id === entry.channelId && (!row.readOnly || row.cached),
          )
      )
        throw new Error("This chat is no longer available for sending.");
      watch();
      if (
        (validated || !entry.beforeRelease) &&
        !blockers(entry.channelId) &&
        !entries.some((item) => item.channelId === entry.channelId)
      )
        return sent(entry);
      if (entries.length >= 50)
        throw new Error(
          "The follow-up queue is full. Send or remove a queued message first.",
        );
      entries = [...entries, { ...entry, id: crypto.randomUUID() }];
      watch();
      emit();
      pump();
      return undefined;
    },
    sendNow(id: string) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        requested.add(id);
        void release(entry);
      }
    },
    remove(id: string) {
      requested.delete(id);
      entries = entries.filter((entry) => entry.id !== id);
      emit();
      pump();
    },
  };
}
