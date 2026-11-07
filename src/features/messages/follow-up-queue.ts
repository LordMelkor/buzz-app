import type { RelaySession } from "../relay/session";
import type { OutboxRecovery } from "../relay/outbox";
import { knownAgentPubkeys } from "../agents/known";
import { ownSolo } from "../solo/labels";
import { followUpMessage } from "./follow-up-message";
import {
  followUpStorage,
  followUpRecovery,
  type FollowUpMessage,
  type FollowUpHandoff,
} from "./follow-up-storage";

type Activity = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Wait = {
  agent: string;
  message?: string;
  turn?: string;
  resumed?: true;
  /** Channel only: give up if no activity for the message ever shows up
   * (or, for `typing`, once the agent stops typing), on the `now()` clock. */
  expires?: number;
  /** Channel only: an agent seen only typing, held across a typing gap
   * that starts when its typing clears. */
  typing?: true;
  /** Channel only: the message's delivery outlived its start gap, which
   * starts again once it's delivered. */
  delivering?: true;
};
// How long a channel waits for an addressed agent's turn to start. A
// teammate's agent may be invisible or offline, and must not hold rows forever.
const START_GAP_MS = 30_000;
// Typing clears for a moment after each reply an agent posts mid-task.
const TYPING_GAP_MS = 5_000;
// Deadlines use a monotonic clock, so moving the system clock moves none.
const now = () => performance.now();
// Saved rows keep order per lane: a Solo chat is one lane, and a channel has
// one lane per agent, so one agent's handoff never holds another's rows.
type Lane = readonly [key: string, recipients: readonly string[]];
const lanes = (
  channelId: string,
  recipients: readonly string[],
  channel?: boolean,
): Lane[] =>
  channel
    ? recipients.map((agent) => [`${channelId}:${agent}`, [agent]])
    : [[channelId, recipients]];
// An agent's request may be in its chat's lane or its own channel lane.
const agentLanes = (channelId: string, agent: string) => [
  channelId,
  `${channelId}:${agent}`,
];
const laneChannel = (key: string) => key.split(":", 1)[0] ?? key;
const rowLanes = (row: {
  channelId: string;
  recipients: readonly string[];
  message?: { channel?: true } | undefined;
  channel?: true;
}) =>
  lanes(row.channelId, row.recipients, !!(row.message?.channel ?? row.channel));
const sharesLane = (
  a: Parameters<typeof rowLanes>[0],
  b: Parameters<typeof rowLanes>[0],
) => {
  const keys = rowLanes(b).map(([key]) => key);
  return rowLanes(a).some(([key]) => keys.includes(key));
};
type Entry = {
  id: string;
  createdAt?: number;
  channelId: string;
  text: string;
  recipients: readonly string[];
  publish(recovery?: OutboxRecovery): string;
  message?: FollowUpMessage;
  restored?: boolean;
  recovered?: true;
  admitted?: boolean;
  resumedBy?: Set<string>;
  deliveryId?: string | undefined;
  dismissedDelivery?: string | undefined;
  resumeCancelled?: boolean;
  predecessorRemoved?: boolean;
  sending?: boolean;
  ready?(): boolean;
  beforeRelease?(): Promise<void>;
  beforePublish?(): void;
  onSend?(id: string): void;
  error?: string;
};
const queues = new WeakMap<RelaySession, ReturnType<typeof createQueue>>();

/** Pending agent follow-ups survive navigation and, with a message payload, restart. */
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
  const storage =
    session.scope && session.viewer
      ? followUpStorage(session.scope)
      : undefined;
  let storageError: string | undefined;
  let sequence = Date.now();
  const waits = new Map<string, Wait[]>();
  // First sight of a channel handoff starts its start gap, like a wait's.
  // Kept per agent and message, so a deadline renewed after a delayed
  // delivery outlives the check that renewed it.
  const handoffWaits = new Map<string, Wait>();
  const edits = new Set<string>();
  // Persist completion of our handoffs so other windows can recognize it.
  const handoffs = new Map<string, FollowUpHandoff>();
  const settlingHandoffs = new Set<string>();
  const refreshingSending = new Set<string>();
  function restore() {
    if (!storage) return;
    try {
      const saved = storage.load();
      sequence = Math.max(sequence, ...saved.map((entry) => entry.createdAt));
      const removed = entries.filter(
        (entry) => !saved.some((row) => row.id === entry.id),
      );
      const predecessors = new Map(
        saved.map((row) => [
          row.id,
          removed.filter(
            (entry) =>
              entry.channelId === row.channelId &&
              sharesLane(entry, row) &&
              entry.createdAt !== undefined &&
              (row.createdAt > entry.createdAt ||
                (row.createdAt === entry.createdAt &&
                  row.id.localeCompare(entry.id) > 0)),
          ),
        ]),
      );
      entries = saved.map((saved) => {
        const existing = entries.find((entry) => entry.id === saved.id);
        if (existing) {
          // Keep the message object captured by the original publish guards.
          existing.text = saved.text;
          if (existing.message) existing.message.text = saved.text;
          return existing;
        }
        return {
          ...saved,
          message: saved,
          restored: true,
          recovered: true,
          ...followUpMessage(session, saved),
        };
      });
      for (const entry of entries) {
        const removed = predecessors.get(entry.id) ?? [];
        if (
          removed.some(
            (prior) =>
              !rowLanes(entry)
                .filter(([key]) =>
                  rowLanes(prior).some(([other]) => other === key),
                )
                .some(([key]) => {
                  const predecessor = storage.handoff(key);
                  return (
                    predecessor?.id === prior.id &&
                    (predecessor.complete ||
                      handoffFinished(predecessor, entry.channelId))
                  );
                }),
          )
        ) {
          entry.restored = true;
          entry.resumeCancelled = true;
          entry.predecessorRemoved = true;
        }
        if (!entry.error)
          entry.sending =
            !entry.dismissedDelivery &&
            (!!entry.deliveryId ||
              saved.find((row) => row.id === entry.id)?.sending === true);
      }
      storageError = undefined;
      refreshSending();
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
  }
  restore();
  // A resumed request supersedes its old observer turn, which may never emit
  // completion after the old process died. Only fresh local work settles it.
  const resumedRequests = new Set<string>();
  const resumedTurn = (turn: Activity["turns"][number]) =>
    !!turn.requests?.length &&
    turn.requests.every((request) =>
      resumedRequests.has(`${turn.agent}:${request.messageId}`),
    );
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publishing = new Set<string>();
  const validating = new Set<string>();
  const requested = new Map<string, (() => void) | undefined>();
  const acknowledging = new Set<string>();
  let activating = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  // A channel delivery still sending, failed or unconfirmed holds its
  // successors, so a retry never lands after a later message.
  const undelivered = (id: string) =>
    !!session.outbox
      ?.snapshot()
      .some(
        (item) =>
          item.event.id === id &&
          item.delivery !== "accepted" &&
          item.delivery !== "seen",
      );
  function finished(wait: Wait, activity: Activity) {
    if (wait.typing) return wait.expires !== undefined && now() > wait.expires;
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
      if (wait.resumed) return false;
      const turns = activity.turns.filter(
        (turn) =>
          turn.agent === wait.agent &&
          turn.requests?.some((request) => request.messageId === wait.message),
      );
      if (turns.length) return turns.every((turn) => turn.state === "ended");
      if (!wait.expires) return false;
      if (undelivered(wait.message)) {
        wait.delivering = true;
        return false;
      }
      // Delivered at last: give the agent its start gap from now.
      if (wait.delivering) {
        delete wait.delivering;
        wait.expires = now() + START_GAP_MS;
        setTimeout(pump, START_GAP_MS + 1);
        return false;
      }
      return now() > wait.expires;
    }
    return activity.turns.some(
      (turn) =>
        turn.agent === wait.agent &&
        turn.turnId === wait.turn &&
        (turn.state === "ended" || resumedTurn(turn)),
    );
  }
  // Solo is one person's workspace, so any work in it holds a follow-up. A
  // shared channel runs many agents at once: only the addressed agents hold it.
  function addressed(channelId: string, recipients: readonly string[]) {
    const channel = session.channels
      .list()
      .channels.find((row) => row.id === channelId);
    return channel && !ownSolo(channel, session.viewer)
      ? new Set(recipients)
      : undefined;
  }
  // `record` keeps the waits it found; a probe from outside the queue only
  // reads, so it never leaves a wait that nothing observes.
  function blockers(
    channelId: string,
    recipients: readonly string[],
    record = true,
  ) {
    const agents = addressed(channelId, recipients);
    const mine = (agent: string) => !agents || agents.has(agent);
    // Typing is evidence from any agent we know of, including a teammate's
    // public profile, and from a thread of the channel; Solo keeps its own.
    const known = agents
      ? knownAgentPubkeys(
          session.profiles?.snapshot() ?? new Map(),
          session.agentChoices?.snapshot(),
        )
      : undefined;
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
        if (
          turn.channelId === channelId &&
          turn.state === "working" &&
          !resumedTurn(turn)
        )
          current.push({ agent: turn.agent, turn: turn.turnId });
      }
    }
    // An agent seen only typing keeps holding through a typing gap after its
    // typing clears; one whose current work this device sees ends with it.
    if (agents) {
      const observed = new Set(
        [
          ...(activity?.local ?? []).filter(
            (row) => row.state === "working" || row.state === "waiting",
          ),
          ...(activity?.turns ?? []).filter((turn) => turn.state === "working"),
        ]
          .filter((row) => row.channelId === channelId)
          .map((row) => row.agent),
      );
      const typing = new Set(
        [
          ...(session.typing?.snapshot() ?? [])
            .filter((entry) => known?.has(entry.pubkey))
            .map((entry) => ({
              agent: entry.pubkey,
              channelId: entry.channelId,
            })),
          ...(activity?.typing ?? []),
        ]
          // Every agent's typing, so checking one row never clears
          // another agent's wait; the result below keeps only ours.
          .filter(
            (entry) =>
              entry.channelId === channelId && !observed.has(entry.agent),
          )
          .map((entry) => entry.agent),
      );
      let cleared = false;
      current = [
        ...current.flatMap((wait) => {
          if (!wait.typing) return [wait];
          // Current work this device sees, or typing again, supersedes it.
          if (observed.has(wait.agent) || typing.has(wait.agent)) return [];
          if (wait.expires !== undefined) return [wait];
          cleared = true;
          return [{ ...wait, expires: now() + TYPING_GAP_MS }];
        }),
        ...[...typing].map((agent) => ({ agent, typing: true as const })),
      ];
      if (record && cleared) setTimeout(pump, TYPING_GAP_MS + 1);
    }
    current = [
      ...new Map(current.map((wait) => [JSON.stringify(wait), wait])).values(),
    ];
    if (record) {
      if (current.length) waits.set(channelId, current);
      else waits.delete(channelId);
    }
    return (
      // A resumed request is a recovery barrier for the whole chat.
      current.some((wait) => wait.resumed || mine(wait.agent)) ||
      (session.typing?.snapshot() ?? []).some(
        (entry) =>
          entry.channelId === channelId &&
          (!!agents || !entry.threadRootId) &&
          mine(entry.pubkey) &&
          (known
            ? known.has(entry.pubkey)
            : session.agentChoices
                ?.snapshot()
                .identities.some((agent) => agent.pubkey === entry.pubkey)),
      ) ||
      (activity?.typing ?? []).some(
        (entry) =>
          entry.channelId === channelId &&
          (!!agents || !entry.threadRootId) &&
          mine(entry.agent),
      ) ||
      // Unobservable activity is a reason to wait in Solo, but a channel
      // message to an agent we cannot see working goes out now.
      (!agents &&
        !!activity &&
        activity.status !== "listening" &&
        activity.status !== "unavailable")
    );
  }
  // Called only while owning the saved row (or for an in-memory-only row).
  async function clearDismissed(entry: Entry) {
    const dismissed = entry.dismissedDelivery;
    if (
      !dismissed ||
      !entries.includes(entry) ||
      entry.deliveryId !== dismissed
    )
      return false;
    if (storage && entry.message && storage.has(entry.id)) {
      const handoff = rowLanes(entry)
        .map(([key]) => storage.handoff(key))
        .find((handoff) => handoff?.id === entry.id);
      const receipt = await session.outbox?.recovery(
        followUpRecovery(entry.id).key,
      );
      if ((handoff?.message && handoff.message !== dismissed) || receipt) {
        entry.dismissedDelivery = undefined;
        entry.deliveryId = receipt?.event.id ?? entry.deliveryId;
        entry.sending = true;
        entries = [...entries];
        emit();
        return false;
      }
      storage.sending(entry.id, false);
    }
    const remaining = (waits.get(entry.channelId) ?? []).filter(
      (wait) => wait.message !== dismissed,
    );
    if (remaining.length) waits.set(entry.channelId, remaining);
    else waits.delete(entry.channelId);
    entry.deliveryId = undefined;
    entry.dismissedDelivery = undefined;
    entry.sending = false;
    entries = [...entries];
    emit();
    return true;
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
      for (const entry of entries)
        if (roster.channels.some((row) => row.id === entry.channelId))
          entry.admitted = true;
      const retired = new Set(
        [
          ...waits.keys(),
          ...[...handoffs.keys()].map(laneChannel),
          ...entries.map((entry) => entry.channelId),
        ].filter((id) => {
          const channel = roster.channels.find((row) => row.id === id);
          return (
            (!channel &&
              (roster.status === "ready" ||
                entries.some(
                  (entry) => entry.channelId === id && entry.admitted,
                ))) ||
            (channel?.readOnly && !channel.cached)
          );
        }),
      );
      if (!retired.size) return;
      for (const entry of entries.filter((entry) =>
        retired.has(entry.channelId),
      ))
        remove(entry.id);
      for (const id of retired) waits.delete(id);
      for (const key of handoffs.keys())
        if (retired.has(laneChannel(key))) handoffs.delete(key);
      emit();
      pump();
    });
    const offDismiss = session.outbox?.observeDismiss((item) => {
      if (item.delivery !== "failed") return;
      for (const handoff of handoffs.values())
        if (handoff.message === item.event.id) handoff.complete = true;
      for (const entry of entries) {
        if (entry.deliveryId !== item.event.id) continue;
        entry.dismissedDelivery = item.event.id;
        const clear = () => clearDismissed(entry);
        if (storage && entry.message)
          void storage
            .lockChat(entry.channelId, () => storage.lock(entry.id, clear))
            .catch((error) => {
              // Keep dismissal evidence so Send can retry this save under its
              // lock. The delivery itself is already durably dismissed.
              entry.sending = false;
              entry.error =
                error instanceof Error ? error.message : String(error);
              entries = [...entries];
              emit();
            });
        else void clear();
      }
      entries = [...entries];
      emit();
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
      for (const entry of entries.filter(
        (entry) => entry.channelId === channelId,
      ))
        remove(entry.id);
      waits.delete(channelId);
      for (const key of handoffs.keys())
        if (laneChannel(key) === channelId) handoffs.delete(key);
      emit();
      pump();
    });
    const offOutbox = session.outbox?.subscribe(() => {
      reconcileDelivery();
      // A delivery that settles may release the rows behind it.
      pump();
    });
    stop = () => {
      offOutbox?.();
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
  function waitForMessage(
    entry: Pick<Entry, "channelId" | "recipients">,
    id: string,
  ) {
    // Include the gap between publication and the first working signal.
    const channel = !!addressed(entry.channelId, entry.recipients);
    waits.set(entry.channelId, [
      ...(waits.get(entry.channelId) ?? []),
      ...entry.recipients.map((agent) => ({
        agent,
        message: id,
        ...(channel ? { expires: now() + START_GAP_MS } : {}),
      })),
    ]);
    if (channel) setTimeout(pump, START_GAP_MS + 1);
    watch();
  }
  function sent(entry: Omit<Entry, "id">, recovery?: OutboxRecovery) {
    const id = entry.publish(recovery);
    waitForMessage(entry, id);
    return id;
  }
  // Recovery metadata bridges the durable queue to the durable Outbox. Keep it
  // until the queue record is removed, then release accepted delivery receipts.
  function reconcileDelivery() {
    if (!storage || !session.outbox) return;
    try {
      for (const item of session.outbox.snapshot()) {
        if (
          !item.recovery?.key.startsWith("follow-up:") ||
          item.acknowledged ||
          (item.delivery !== "accepted" && item.delivery !== "seen") ||
          storage.has(item.recovery.value) ||
          acknowledging.has(item.event.id)
        )
          continue;
        acknowledging.add(item.event.id);
        void session.outbox
          .acknowledge(item.event.id)
          .catch(() => {})
          .finally(() => {
            acknowledging.delete(item.event.id);
            pump();
          });
      }
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
      emit();
    }
  }
  async function release(entry: Entry, locked = false): Promise<void> {
    if (storage && entry.message && !locked) {
      try {
        await storage.lockChat(entry.channelId, () =>
          storage.lock(entry.id, () => release(entry, true)),
        );
      } catch (error) {
        entries = entries.map((item) =>
          item === entry
            ? {
                ...item,
                error: error instanceof Error ? error.message : String(error),
              }
            : item,
        );
        emit();
      }
      return;
    }
    if (locked && storage && entry.message) {
      const saved = storage.load().find((row) => row.id === entry.id);
      if (saved) {
        entry.text = saved.text;
        entry.message.text = saved.text;
      }
    }
    if (
      !entries.includes(entry) ||
      publishing.has(entry.id) ||
      edits.has(entry.id)
    )
      return;
    publishing.add(entry.id);
    let id: string | undefined;
    let awaitingChoices = false;
    let claimed = false;
    try {
      if (entry.dismissedDelivery && !(await clearDismissed(entry))) return;
      if (storage && entry.message) {
        if (!storage.has(entry.id)) {
          restore();
          return;
        }
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.ready();
        const previous = await session.outbox.recovery(
          followUpRecovery(entry.id).key,
        );
        if (!previous && entry.deliveryId) {
          entry.dismissedDelivery = entry.deliveryId;
          if (!(await clearDismissed(entry))) return;
        }
        if (previous) {
          entry.deliveryId = previous.event.id;
          if (
            !session.outbox
              .snapshot()
              .some((item) => item.event.id === previous.event.id)
          )
            throw new Error(
              "This message is owned by another window. Reload to recover its delivery.",
            );
          const owner = await storage.owner();
          for (const [key, recipients] of rowLanes(entry))
            if (storage.handoff(key)?.id === entry.id) {
              const handoff = {
                id: entry.id,
                message: previous.event.id,
                recipients,
                owner,
              };
              storage.claim(key, handoff);
              handoffs.set(key, handoff);
            }
          await session.outbox.recover(
            previous.event.id,
            followUpRecovery(entry.id),
            () => {
              storage.remove(entry.id);
              waitForMessage(entry, previous.event.id);
            },
          );
          entries = entries.filter((item) => item !== entry);
          return;
        }
        if (storage.isSending(entry.id))
          throw new Error(
            "This message may already be sending in another window. Reload to recover its delivery. If it was interrupted before sending, check the conversation before removing this row and sending again.",
          );
      }
      // This window owns the lock, but has not started an Outbox handoff.
      // Remove may cancel its own validation; other windows still need the lock.
      validating.add(entry.id);
      if (entry.beforeRelease) await entry.beforeRelease();
      validating.delete(entry.id);
      const owner =
        storage && entry.message ? await storage.owner() : undefined;
      let livePredecessor = false;
      if (storage && entry.message && !requested.has(entry.id))
        for (const [key] of rowLanes(entry)) {
          const predecessor = storage.handoff(key);
          if (
            predecessor &&
            !predecessor.complete &&
            !handoffFinished(predecessor, entry.channelId) &&
            predecessor.id !== handoffs.get(key)?.id &&
            (await storage.isLive(predecessor))
          )
            livePredecessor = true;
        }
      // Ownership queries can yield to pauses, removals, and new activity.
      // Keep the final publication guards and claim in one synchronous step.
      if (!entries.includes(entry)) return;
      if (
        !requested.has(entry.id) &&
        (entry.restored || blockers(entry.channelId, entry.recipients))
      )
        return;
      if (storage && entry.message && !storage.has(entry.id)) return;
      if (entry.ready?.() === false) {
        awaitingChoices = true;
        return;
      }
      if (storage && entry.message) {
        const first = storage
          .load()
          .find(
            (row) =>
              row.channelId === entry.channelId && sharesLane(row, entry),
          );
        if (
          !requested.has(entry.id) &&
          (first?.id !== entry.id || livePredecessor)
        ) {
          entries = entries.map((item) =>
            item === entry
              ? {
                  ...item,
                  restored: true,
                  resumeCancelled: true,
                  error:
                    "Another window may be handling an earlier queued message. Check the conversation, then Send when ready.",
                }
              : item,
          );
          return;
        }
      }
      entry.beforePublish?.();
      requested.get(entry.id)?.();
      if (storage && entry.message) {
        // Retain the claim after removing the row: storage events and agent
        // activity in another window may both arrive after this handoff.
        // Set first: a later lane's failed claim settles those already saved.
        claimed = true;
        for (const [key, recipients] of rowLanes(entry))
          storage.claim(key, {
            id: entry.id,
            recipients,
            ...(owner ? { owner } : {}),
          });
        storage.sending(entry.id, true);
      }
      entry.sending = true;
      entries = [...entries];
      emit();
      try {
        id = sent(
          entry,
          entry.message ? followUpRecovery(entry.id) : undefined,
        );
        entry.deliveryId = id;
        if (storage && entry.message)
          for (const [key, recipients] of rowLanes(entry)) {
            const handoff = {
              id: entry.id,
              message: id,
              recipients,
              ...(owner ? { owner } : {}),
            };
            handoffs.set(key, handoff);
            storage.claim(key, handoff);
          }
      } catch (error) {
        if (storage && entry.message && !id) storage.sending(entry.id, false);
        throw error;
      }
      if (storage && entry.message) {
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.recover(id, followUpRecovery(entry.id), () =>
          storage.remove(entry.id),
        );
      }
      entries = entries.filter((item) => item !== entry);
    } catch (error) {
      if (claimed && !id)
        for (const [key, recipients] of rowLanes(entry))
          handoffs.set(key, { id: entry.id, recipients, complete: true });
      entries = entries.map((item) =>
        item === entry
          ? {
              ...item,
              sending: !!item.deliveryId && !item.dismissedDelivery,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    } finally {
      validating.delete(entry.id);
      publishing.delete(entry.id);
      if (!awaitingChoices) requested.delete(entry.id);
      emit();
      reconcileDelivery();
      queueMicrotask(pump);
    }
    // Presentation failures cannot put an already accepted message back in queue.
    if (id) entry.onSend?.(id);
  }
  // A channel row any window handed off holds its agent's lane until the
  // agent finishes; release drops one whose window has closed.
  function handedOff(channelId: string, recipients: readonly string[]) {
    return lanes(channelId, recipients, true).some(([key]) => {
      const handoff = storage?.handoff(key);
      return !!handoff && !handoff.complete;
    });
  }
  function handoffFinished(handoff: FollowUpHandoff, channelId: string) {
    const activity = session.agentActivity?.snapshot();
    const message = handoff.message;
    if (!message) return false;
    // Only the window that sent it sees its delivery in its Outbox, so only
    // that window gives up on a channel handoff after its start gap; it then
    // marks the handoff complete. Another window waits for that, or for the
    // agent's work, or for the sending window to close.
    const channel =
      addressed(channelId, handoff.recipients) &&
      [...handoffs.values()].some((own) => own.id === handoff.id);
    const pending = handoff.recipients.map((agent) => {
      const id = `${agent}:${message}`;
      const wait = handoffWaits.get(id) ?? { agent, message };
      handoffWaits.set(id, wait);
      if (channel && wait.expires === undefined) {
        wait.expires = now() + START_GAP_MS;
        setTimeout(pump, START_GAP_MS + 1);
      }
      if (resumedRequests.has(id)) wait.resumed = true;
      return wait;
    });
    // Nor while it still sees the agent working, so a window that sees less
    // cannot send into that work.
    return (
      !!activity &&
      pending.every((wait) => finished(wait, activity)) &&
      !(channel && blockers(channelId, handoff.recipients))
    );
  }
  function pump() {
    if (activating) return;
    for (const [key, handoff] of handoffs) {
      const channelId = laneChannel(key);
      if (
        !storage ||
        (!handoff.complete && !handoffFinished(handoff, channelId)) ||
        settlingHandoffs.has(key)
      )
        continue;
      settlingHandoffs.add(key);
      void storage
        .lockChat(channelId, async () => {
          if (handoffs.get(key) !== handoff) return;
          const current = storage.handoff(key);
          if (
            current?.id === handoff.id &&
            (!current.message || current.message === handoff.message)
          )
            storage.claim(key, { ...handoff, complete: true });
          if (handoffs.get(key) === handoff) handoffs.delete(key);
        })
        .catch((error) => {
          storageError = error instanceof Error ? error.message : String(error);
          emit();
        })
        .finally(() => {
          settlingHandoffs.delete(key);
          if (handoffs.get(key) !== handoff) pump();
        });
    }
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
      const manual = entries.filter(
        (entry) =>
          entry.channelId === channelId &&
          requested.has(entry.id) &&
          entry.ready?.() !== false,
      );
      if (manual.length) {
        for (const entry of manual) void release(entry);
        continue;
      }
      const rows = entries.filter((entry) => entry.channelId === channelId);
      // A row being edited still holds its own agents' later rows, but not
      // another agent's.
      const releasable = (entry: Entry) =>
        !entry.error &&
        !entry.restored &&
        !edits.has(entry.id) &&
        entry.ready?.() !== false;
      if (!addressed(channelId, [])) {
        const first = rows[0];
        if (blockers(channelId, first?.recipients ?? [])) continue;
        if (first && releasable(first)) void release(first);
        continue;
      }
      // A channel keeps each agent's rows in order, so one agent's queue
      // never holds a row for another.
      if (!rows.length) blockers(channelId, []);
      const next = rows.find(
        (entry, index) =>
          !rows
            .slice(0, index)
            .some((earlier) =>
              earlier.recipients.some((agent) =>
                entry.recipients.includes(agent),
              ),
            ) &&
          releasable(entry) &&
          !blockers(channelId, entry.recipients),
      );
      if (next) void release(next);
    }
    if (
      !entries.length &&
      !waits.size &&
      !handoffs.size &&
      !session.outbox
        ?.snapshot()
        .some(
          (item) =>
            item.recovery?.key.startsWith("follow-up:") && !item.acknowledged,
        )
    ) {
      const dispose = stop;
      stop = undefined;
      dispose?.();
    }
  }
  async function remove(id: string, locked = false) {
    const entry = entries.find((item) => item.id === id);
    try {
      if (entry?.dismissedDelivery) {
        if (storage && entry.message && !locked) {
          await storage.lockChat(entry.channelId, () =>
            storage.lock(id, () => remove(id, true)),
          );
          reconcileDelivery();
          pump();
          return;
        }
        if (!(await clearDismissed(entry))) return;
      }
      if (entry?.deliveryId || (entry?.sending && publishing.has(id))) return;
      if (
        entry?.message &&
        storage &&
        navigator.locks &&
        !locked &&
        !validating.has(id)
      ) {
        await storage.tryLock(id, async () => {
          await remove(id, true);
          reconcileDelivery();
          pump();
        });
        return;
      }
      if (entry?.message && storage?.isSending(id)) {
        if (!session.outbox) return;
        const receipt = await session.outbox.recovery(followUpRecovery(id).key);
        if (receipt) {
          entry.deliveryId = receipt.event.id;
          entry.sending = true;
          emit();
          return;
        }
      }
      if (entry?.message) storage?.remove(id);
      requested.delete(id);
      entries = entries.filter((item) => item.id !== id);
    } catch (error) {
      entries = entries.map((item) =>
        item.id === id
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    }
    emit();
  }
  function refreshSending() {
    for (const entry of entries) {
      if (!entry.sending || !storage || refreshingSending.has(entry.id))
        continue;
      refreshingSending.add(entry.id);
      // Wait for the current handoff to release ownership, including a window
      // closing or persistence failing without another storage event.
      void storage
        .lock(entry.id, async () => {
          if (!entries.includes(entry) || publishing.has(entry.id)) return;
          if (entry.dismissedDelivery) {
            await clearDismissed(entry);
            return;
          }
          await session.outbox?.ready();
          if (!entries.includes(entry)) return;
          if (!session.outbox) return;
          const receipt = await session.outbox.recovery(
            followUpRecovery(entry.id).key,
          );
          if (!entries.includes(entry)) return;
          if (!receipt && entry.deliveryId) {
            entry.dismissedDelivery = entry.deliveryId;
            await clearDismissed(entry);
            return;
          }
          entry.deliveryId = receipt?.event.id;
          entry.sending = !!entry.deliveryId;
          entries = [...entries];
          emit();
        })
        .catch(() => {})
        .finally(() => refreshingSending.delete(entry.id));
    }
  }
  const onStorage = () => {
    restore();
    if (entries.length) watch();
    emit();
    pump();
  };
  if (entries.length) watch();
  if (storage && session.outbox)
    void session.outbox
      .ready()
      .then(() => {
        if (
          session.outbox
            ?.snapshot()
            .some(
              (item) =>
                item.recovery?.key.startsWith("follow-up:") &&
                !item.acknowledged,
            )
        ) {
          watch();
          reconcileDelivery();
        }
      })
      .catch(() => {});
  return {
    snapshot: () => entries,
    /** Whether work this device can see, or a row for one of these agents
     * still queued or being released, would hold a message to them. A
     * channel message to no agent has no lane to wait in, so it never is.
     * Rows another window saved count too, as they do for `submit`, and so
     * does a channel row any window handed off (`handedOff`). */
    busy(channelId: string, recipients: readonly string[]) {
      if (recipients.length || !addressed(channelId, recipients)) restore();
      else return false;
      return (
        entries.some(
          (entry) =>
            entry.channelId === channelId &&
            entry.recipients.some((agent) => recipients.includes(agent)),
        ) ||
        handedOff(channelId, recipients) ||
        blockers(channelId, recipients, false)
      );
    },
    storageError: () => storageError,
    subscribe(listener: () => void) {
      if (storage && !listeners.size) {
        onStorage();
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (storage && !listeners.size)
          window.removeEventListener("storage", onStorage);
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
      if (entry.message) restore();
      if (entry.message && (!storage || storageError))
        throw new Error(
          storageError ?? "Queued message storage is unavailable.",
        );
      watch();
      if (
        (validated || !entry.beforeRelease) &&
        !blockers(entry.channelId, entry.recipients) &&
        !entries.some((item) => item.channelId === entry.channelId) &&
        !(
          entry.message?.channel && handedOff(entry.channelId, entry.recipients)
        )
      )
        return sent(entry);
      if (entries.length >= 50)
        throw new Error(
          "The follow-up queue is full. Send or remove a queued message first.",
        );
      const id = crypto.randomUUID();
      const createdAt = ++sequence;
      if (entry.message) {
        if (!storage) throw new Error("Queued message storage is unavailable.");
        storage.save({ ...entry.message, id, createdAt });
      }
      entries = [...entries, { ...entry, id, createdAt, admitted: true }];
      watch();
      emit();
      pump();
      return undefined;
    },
    /** Resume only the chats the runner is actually recovering. Seed the
     * request barriers before it reads/restarts them, including reconnects. */
    resumeAfter(
      agent: string,
      turns: Readonly<Record<string, string>>,
      beforePublish?: (entry: Pick<Entry, "channelId" | "recipients">) => void,
    ) {
      restore();
      const channels = new Set(Object.values(turns).filter(Boolean));
      for (const [message, channelId] of Object.entries(turns)) {
        if (!channelId) continue;
        let resumedHandoff: FollowUpHandoff | undefined;
        let key = channelId;
        try {
          for (const lane of agentLanes(channelId, agent)) {
            const handoff = storage?.handoff(lane);
            if (
              handoff &&
              !handoff.complete &&
              handoff.message === message &&
              handoff.recipients.includes(agent)
            ) {
              resumedHandoff = handoff;
              key = lane;
              break;
            }
          }
        } catch (error) {
          storageError = error instanceof Error ? error.message : String(error);
        }
        if (resumedHandoff && storage) {
          const handoff = resumedHandoff;
          handoffs.set(key, handoff);
          void storage
            .lockChat(channelId, async () => {
              const current = storage.handoff(key);
              if (current?.id !== handoff.id || current.complete) return;
              handoff.owner = await storage.owner();
              storage.claim(key, {
                ...current,
                owner: handoff.owner,
              });
            })
            .catch((error) => {
              storageError =
                error instanceof Error ? error.message : String(error);
              emit();
            });
        }
        if (
          !resumedHandoff &&
          !entries.some((entry) => entry.channelId === channelId)
        )
          continue;
        resumedRequests.add(`${agent}:${message}`);
        waits.set(channelId, [
          ...(waits.get(channelId) ?? []),
          { agent, message, resumed: true },
        ]);
      }
      entries = entries.map((entry) => {
        if (
          (entry.restored || entry.resumedBy) &&
          !entry.resumeCancelled &&
          channels.has(entry.channelId)
        ) {
          entry.resumedBy ??= new Set();
          for (const [request, channelId] of Object.entries(turns))
            if (channelId === entry.channelId)
              entry.resumedBy.add(`${agent}:${request}`);
          entry.restored = false;
          entry.beforePublish = () => beforePublish?.(entry);
        }
        return entry;
      });
      if (entries.length || handoffs.size) watch();
      emit();
      // Other agents in the same Resume decision seed their barriers first.
      queueMicrotask(pump);
    },
    /** A request positively abandoned by the runner is not completion evidence. */
    pauseAfter(agent: string, turns: Readonly<Record<string, string>>) {
      const channels = new Set(Object.values(turns));
      for (const channelId of channels) {
        if (!storage) continue;
        void storage
          .lockChat(channelId, async () => {
            for (const key of agentLanes(channelId, agent)) {
              const marker = storage.handoff(key);
              if (
                marker?.message &&
                marker.message in turns &&
                marker.recipients.includes(agent)
              ) {
                const recipients = marker.recipients.filter(
                  (recipient) => recipient !== agent,
                );
                if (recipients.length)
                  storage.claim(key, { ...marker, recipients });
                else storage.retire(key);
              }
            }
          })
          .catch((error) => {
            storageError =
              error instanceof Error ? error.message : String(error);
            emit();
          });
      }
      for (const [key, handoff] of handoffs)
        if (
          handoff.message &&
          handoff.message in turns &&
          handoff.recipients.includes(agent)
        ) {
          const recipients = handoff.recipients.filter(
            (recipient) => recipient !== agent,
          );
          if (recipients.length) handoffs.set(key, { ...handoff, recipients });
          else handoffs.delete(key);
        }
      for (const [channelId, current] of waits) {
        const remaining = current.filter(
          (wait) =>
            !(
              wait.resumed &&
              wait.agent === agent &&
              wait.message &&
              wait.message in turns
            ),
        );
        if (remaining.length) waits.set(channelId, remaining);
        else waits.delete(channelId);
      }
      entries = entries.map((entry) => {
        if (
          (entry.recovered || entry.resumedBy) &&
          channels.has(entry.channelId)
        ) {
          entry.restored = true;
          entry.resumeCancelled = true;
        }
        return entry;
      });
      emit();
      pump();
    },
    edit(id: string) {
      const entry = entries.find((item) => item.id === id);
      if (
        !entry?.message ||
        !storage ||
        entry.sending ||
        publishing.has(id) ||
        edits.has(id)
      )
        throw new Error("This queued message is no longer available to edit.");
      const originalText = entry.text;
      edits.add(id);
      let closed = false;
      const cancel = () => {
        if (closed) return;
        closed = true;
        edits.delete(id);
        pump();
      };
      return {
        cancel,
        async save(text: string) {
          if (closed) throw new Error("This edit is no longer available.");
          if (!text.trim() && !entry.message?.attachments.length)
            throw new Error("Enter a message or keep an attachment.");
          await storage.lock(id, async () => {
            if (closed) throw new Error("This edit is no longer available.");
            const saved = storage.load().find((row) => row.id === id);
            if (!saved || saved.sending || entry.deliveryId)
              throw new Error(
                "This message has already been sent or removed. Your edit has been kept.",
              );
            if (saved.text !== originalText)
              throw new Error(
                "This message changed in another window. Your edit has been kept.",
              );
            storage.save({ ...saved, text });
            entry.text = text;
            if (entry.message) entry.message.text = text;
            entries = [...entries];
            emit();
          });
          cancel();
        },
      };
    },
    sendNow(id: string, beforePublish?: () => void) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        requested.set(id, beforePublish);
        void release(entry);
      }
    },
    remove(id: string) {
      remove(id);
      reconcileDelivery();
      pump();
    },
  };
}
