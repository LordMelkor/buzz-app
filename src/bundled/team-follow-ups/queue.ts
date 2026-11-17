import { knownAgentPubkeys } from "../../features/agents/known";
import { archivedMention } from "../../features/messages/mention-admission";
import type { OutgoingMessage } from "../../features/messages/outgoing-message";
import type { RelaySession } from "../../features/relay/session";
import {
  ownsStorageKey,
  rowStorage,
  windowOwners,
  type RowStorage,
  type SavedRow,
} from "./storage";

// How long a released message waits for its agent's turn to start. A
// teammate's agent may be invisible or offline and must not hold rows forever.
const START_GAP_MS = 30_000;
// Typing clears for a moment after each reply an agent posts mid-task.
const TYPING_GAP_MS = 5_000;
// Deadlines use a monotonic clock, so moving the system clock moves none.
const now = () => performance.now();
// Saved rows per account and community, as Solo's queue allows. At the cap
// the gate refuses a message it would hold, as Solo's queue does.
const MAX_ROWS = 50;

/** What a row shows, derived from its saved owner and this window's attempt:
 * - this window's row: queued → sending → (sent and removed | queued again
 *   when new work came first | failed); failed → sending on Send;
 * - another window's row: `elsewhere` while that window lives, then
 *   `paused`, as every row is after a restart or plugin reload. Send takes
 *   it, making it this window's;
 * - any row but a sending one: ⇄ editing, while the composer edits its text
 *   (until a save or cancel); removed by Remove. Editing another live
 *   window's row takes it, so that window can't send it meanwhile. An edit
 *   whose row was sent or removed elsewhere keeps its text in the composer,
 *   and its save fails.
 * Only a queued row of this window releases on its own. */
export type RowPhase =
  | "queued"
  | "editing"
  | "sending"
  | "failed"
  | "elsewhere"
  | "paused";
export type QueuedRow = Readonly<{
  id: string;
  channelId: string;
  text: string;
  attachments: number;
  phase: RowPhase;
  error?: string;
  /** A recipient is compacting its session here, so Send waits, as in Solo. */
  compacting?: boolean;
}>;
/** A release attempt of this window's row; none means queued. */
type Attempt = { phase: "sending" } | { phase: "failed"; error: string };
type Snapshot = Readonly<{ rows: readonly QueuedRow[]; error?: string }>;
/** An open edit: the row as it was when editing began, and its account and
 * community. */
type Edit = { row: SavedRow; scope: string };

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Runs `next` with a locked step's result: at once when it ran at once
 * (no Web Locks), otherwise when the lock is granted. */
export const after = <T, U>(
  value: T | Promise<T>,
  next: (value: T) => U,
): U | Promise<U> =>
  value instanceof Promise ? value.then(next) : next(value);

/** Team channel follow-ups: holds top-level messages to busy agents, then
 * publishes each when its agents are free, one agent's rows in order. */
export function createTeamQueue(options: {
  preference(): "immediate" | "queue";
  publish(session: RelaySession, message: OutgoingMessage): string;
  /** A local agent compacting its session here can't take a message yet. */
  compacting?(agent: string, channelId: string): boolean;
  subscribeAgents?(listener: () => void): () => void;
}) {
  let session: RelaySession | undefined;
  let storage: RowStorage | undefined;
  let disposed = false;
  let storageError: string | undefined;
  const listeners = new Set<() => void>();
  const attempts = new Map<string, Attempt>();
  const editing = new Map<string, Edit>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Each handoff's start gap, from this window's release or delivery.
  const gaps = new Map<string, { expires: number; delivering?: boolean }>();
  // Agents seen typing with no work this device sees, and their grace.
  let typing = new Set<string>();
  const grace = new Map<string, number>();
  let unbind: (() => void) | undefined;
  // The activity lease, held only while rows or a start gap need it, as
  // Solo's queue does, so turning Agent Activity off still stops the stream.
  let lease: (() => void) | undefined;
  let snapshot: Snapshot = { rows: [] };
  const owners = windowOwners(() => changed());
  const lane = (channelId: string, agent: string) =>
    JSON.stringify([channelId, agent]);
  const compacting = (message: OutgoingMessage) =>
    message.recipients.some(
      (agent) => !!options.compacting?.(agent, message.channelId),
    );

  function later(ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      changed();
    }, ms + 1);
    timers.add(timer);
  }
  function needActivity(want: boolean) {
    if (want && session && !lease) lease = session.agentActivity.activate();
    else if (!want && lease) {
      lease();
      lease = undefined;
    }
  }
  function rows() {
    try {
      return storage?.rows() ?? [];
    } catch (error) {
      storageError = failure(error);
      return [];
    }
  }
  function phase(row: SavedRow): RowPhase {
    if (editing.has(row.id)) return "editing";
    if (row.owner === owners.name)
      return attempts.get(row.id)?.phase ?? "queued";
    return owners.live(row.owner) ? "elsewhere" : "paused";
  }
  function render() {
    const saved = rows();
    // Unbound (reconnecting), there are no rows to compare with.
    if (storage) {
      for (const id of attempts.keys())
        if (!saved.some((row) => row.id === id && row.owner === owners.name))
          attempts.delete(id);
      for (const [id, edit] of editing)
        if (edit.scope !== session?.scope) editing.delete(id);
    }
    snapshot = {
      rows: saved.map((row) => {
        const current = phase(row);
        const attempt = attempts.get(row.id);
        const error =
          current === "failed" && attempt?.phase === "failed"
            ? attempt.error
            : undefined;
        return {
          id: row.id,
          channelId: row.message.channelId,
          text: row.message.text,
          attachments: row.message.attachments.length,
          phase: current,
          ...(error ? { error } : {}),
          ...(compacting(row.message) ? { compacting: true } : {}),
        };
      }),
      ...(storageError ? { error: storageError } : {}),
    };
    needActivity(
      saved.length > 0 || [...gaps.values()].some((gap) => gap.expires > now()),
    );
    for (const listener of listeners) listener();
  }
  function changed() {
    if (disposed) return;
    render();
    pump();
  }

  // Busy evidence this device sees for one agent in one channel.
  function observe() {
    if (!session) return;
    const activity = session.agentActivity.snapshot();
    const known = knownAgentPubkeys(
      session.profiles.snapshot(),
      session.agentChoices.snapshot(),
    );
    const working = new Set(
      [
        ...(activity.local ?? []).filter(
          (row) => row.state === "working" || row.state === "waiting",
        ),
        ...activity.turns.filter((turn) => turn.state === "working"),
      ].flatMap((row) =>
        row.channelId ? [lane(row.channelId, row.agent)] : [],
      ),
    );
    // Typing in the channel or any of its threads, by any agent we know of.
    const next = new Set(
      [
        ...session.typing
          .snapshot()
          .filter((entry) => known.has(entry.pubkey))
          .map((entry) => lane(entry.channelId, entry.pubkey)),
        ...activity.typing.map((entry) => lane(entry.channelId, entry.agent)),
      ].filter((key) => !working.has(key)),
    );
    for (const key of typing)
      if (!next.has(key) && !working.has(key)) {
        grace.set(key, now() + TYPING_GAP_MS);
        later(TYPING_GAP_MS);
      }
    for (const key of [...next, ...working]) grace.delete(key);
    typing = next;
    return { activity, working };
  }
  type Seen = NonNullable<ReturnType<typeof observe>>;
  function requestEnded(seen: Seen, agent: string, message: string) {
    const local = seen.activity.local?.find(
      (row) => row.agent === agent && row.messageId === message,
    );
    if (local) return !["working", "waiting"].includes(local.state);
    const turns = seen.activity.turns.filter(
      (turn) =>
        turn.agent === agent &&
        turn.requests?.some((request) => request.messageId === message),
    );
    return turns.length
      ? turns.every((turn) => turn.state === "ended")
      : undefined;
  }
  // A released message holds its agent until the agent has handled it, or
  // its start gap passes with no sign of work. Only the releasing window sees
  // the delivery, so another window's handoff holds until that window closes.
  function handedOff(seen: Seen, channelId: string, agent: string) {
    const handoff = storage?.handoff(channelId, agent);
    if (!handoff || !storage) return false;
    const key = lane(channelId, agent);
    const ended = requestEnded(seen, agent, handoff.message);
    if (handoff.owner !== owners.name) {
      if (owners.live(handoff.owner)) return ended !== true;
      storage.retire(channelId, agent);
      return false;
    }
    if (ended === undefined) {
      let gap = gaps.get(key);
      if (!gap) {
        gap = { expires: now() + START_GAP_MS };
        gaps.set(key, gap);
        later(START_GAP_MS);
      }
      const undelivered = session?.outbox
        ?.snapshot()
        .some(
          (item) =>
            item.event.id === handoff.message &&
            item.delivery !== "accepted" &&
            item.delivery !== "seen",
        );
      if (undelivered) {
        gap.delivering = true;
        return true;
      }
      if (gap.delivering) {
        // Delivered at last: the agent gets its start gap from now.
        gap.delivering = false;
        gap.expires = now() + START_GAP_MS;
        later(START_GAP_MS);
        return true;
      }
      if (now() <= gap.expires) return true;
    } else if (!ended) return true;
    storage.retire(channelId, agent);
    gaps.delete(key);
    return false;
  }
  function busy(seen: Seen, channelId: string, agent: string) {
    const key = lane(channelId, agent);
    return (
      seen.working.has(key) ||
      typing.has(key) ||
      !!options.compacting?.(agent, channelId) ||
      (grace.get(key) ?? 0) > now() ||
      handedOff(seen, channelId, agent)
    );
  }
  // An earlier row for one of these agents, in any phase or window.
  const behind = (saved: readonly SavedRow[], row: SavedRow) =>
    saved
      .slice(
        0,
        Math.max(
          0,
          saved.findIndex((item) => item.id === row.id),
        ),
      )
      .some(
        (earlier) =>
          earlier.message.channelId === row.message.channelId &&
          earlier.message.recipients.some((agent) =>
            row.message.recipients.includes(agent),
          ),
      );

  function pump() {
    if (disposed || !session) return;
    const seen = observe();
    if (!seen) return;
    const saved = rows();
    for (const row of saved)
      if (
        row.owner === owners.name &&
        phase(row) === "queued" &&
        !behind(saved, row) &&
        !row.message.recipients.some((agent) =>
          busy(seen, row.message.channelId, agent),
        )
      )
        void release(row.id, false);
  }
  async function release(id: string, requested: boolean) {
    const current = session;
    const store = storage;
    if (!current || !store || attempts.get(id)?.phase === "sending") return;
    const attempt: Attempt = { phase: "sending" };
    attempts.set(id, attempt);
    render();
    try {
      const row = store.row(id);
      if (!row) return;
      const { message } = row;
      const roster = await current.channelWrites.refreshMembership(
        message.channelId,
      );
      // The saved row, while this window may still send it as read: a
      // removal, another window's Send or Edit, a reconnect or new work may
      // come first.
      const due = () => {
        const latest = store.row(id);
        const seen = observe();
        if (
          disposed ||
          current !== session ||
          !seen ||
          latest?.owner !== owners.name ||
          latest.message.text !== message.text ||
          attempts.get(id) !== attempt
        )
          return;
        if (
          !requested &&
          (editing.has(id) ||
            behind(rows(), latest) ||
            message.recipients.some((agent) =>
              busy(seen, message.channelId, agent),
            ))
        )
          return;
        return latest;
      };
      if (!due()) return;
      if (compacting(message))
        throw new Error("Wait for compaction to finish, or interrupt it.");
      if (message.recipients.some((key) => !roster.members?.includes(key)))
        throw new Error(
          "A queued recipient is no longer a member of this chat.",
        );
      const channel = current.channels
        .list()
        .channels.find((row) => row.id === message.channelId);
      if (!channel || channel.archived || channel.readOnly)
        throw new Error("This chat is no longer available for sending.");
      if (message.recipients.some((key) => archivedMention(current, key)))
        throw new Error("A queued recipient is no longer available.");
      // The last check, the publish and the removal hold the row's lock,
      // which another window's Send or Edit takes to claim the row: a claim
      // that came first stops this send, and a later one finds no row.
      await store.locked(id, () => {
        const latest = due();
        if (!latest) return;
        const sent = options.publish(current, latest.message);
        attempts.delete(id);
        store.remove(id);
        try {
          for (const agent of message.recipients) {
            store.handOff(message.channelId, agent, {
              row: id,
              message: sent,
              owner: owners.name,
            });
            gaps.set(lane(message.channelId, agent), {
              expires: now() + START_GAP_MS,
            });
          }
          later(START_GAP_MS);
        } catch (error) {
          storageError = failure(error);
        }
      });
    } catch (error) {
      if (attempts.get(id) === attempt)
        attempts.set(id, { phase: "failed", error: failure(error) });
    } finally {
      // An attempt that neither sent nor failed leaves the row queued.
      if (attempts.get(id) === attempt) attempts.delete(id);
      changed();
    }
  }
  // Send, Edit and Remove act on any row; a row this window takes is its own.
  // Call under the row's lock, so a release elsewhere sees the new owner.
  function adopt(store: RowStorage, row: SavedRow) {
    if (row.owner !== owners.name) store.save({ ...row, owner: owners.name });
  }
  const onStorage = (event: StorageEvent) => {
    if (ownsStorageKey(event.key)) changed();
  };

  return {
    /** The send gate. Holds only a top-level message whose every recipient is
     * a known agent, when one of them is busy in this channel; saves it first.
     * At the cap it refuses such a message, so the composer keeps it. */
    hold(
      message: OutgoingMessage,
      offered: RelaySession,
    ): boolean | { refuse: string } {
      if (disposed || offered !== session || !storage) return false;
      if (options.preference() !== "queue" || message.threadRootId)
        return false;
      const channel = offered.channels
        .list()
        .channels.find((row) => row.id === message.channelId);
      // A queued row checks the roster before it goes, which needs a
      // session that can manage channels.
      if (
        !channel ||
        channel.channelType === "solo" ||
        !(offered.outbox?.supports(9007) || offered.outbox?.supports(9000))
      )
        return false;
      const known = knownAgentPubkeys(
        offered.profiles.snapshot(),
        offered.agentChoices.snapshot(),
      );
      if (
        !message.recipients.length ||
        !message.recipients.every((key) => known.has(key))
      )
        return false;
      needActivity(true);
      const seen = observe();
      const saved = rows();
      if (
        !seen ||
        !message.recipients.some(
          (agent) =>
            busy(seen, message.channelId, agent) ||
            saved.some(
              (row) =>
                row.message.channelId === message.channelId &&
                row.message.recipients.includes(agent),
            ),
        )
      ) {
        render();
        return false;
      }
      if (saved.length >= MAX_ROWS)
        return {
          refuse:
            "The follow-up queue is full. Send or remove a queued message first.",
        };
      const id = crypto.randomUUID();
      try {
        storage.save({
          id,
          createdAt: Date.now(),
          owner: owners.name,
          message,
        });
      } catch (error) {
        storageError = failure(error);
        render();
        return false;
      }
      render();
      return true;
    },
    /** Follows the relay's ready session; rows stay saved across reconnects. */
    bind(next: RelaySession | undefined) {
      if (disposed || next === session) return;
      unbind?.();
      unbind = undefined;
      session = next;
      storage = next ? rowStorage(next.scope) : undefined;
      if (next) {
        const stops = [
          next.agentActivity.subscribe(changed),
          next.typing.subscribe(changed),
          next.channels.subscribeList(changed),
          next.outbox?.subscribe(changed),
          options.subscribeAgents?.(changed),
        ];
        window.addEventListener("storage", onStorage);
        unbind = () => {
          window.removeEventListener("storage", onStorage);
          for (const stop of stops) stop?.();
          needActivity(false);
        };
      }
      changed();
    },
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(id: string) {
      const store = storage;
      if (!store) return;
      editing.delete(id);
      void Promise.resolve(
        after(
          store.locked(id, () => {
            const row = store.row(id);
            if (row) adopt(store, row);
          }),
          () => release(id, true),
        ),
      ).catch((error) => {
        storageError = failure(error);
        changed();
      });
    },
    /** Starts editing a row's text, for the composer to open: the row waits
     * until `save` returns or `cancel` runs. `save` changes the text only;
     * the rest of the message stays as held. Errors are Solo's. With Web
     * Locks, the edit starts once the row's lock is granted. */
    edit(id: string) {
      const store = storage;
      const scope = session?.scope;
      if (!store) return;
      return store.locked(id, () => {
        const row = store.row(id);
        if (
          !row ||
          !session ||
          session.scope !== scope ||
          editing.has(id) ||
          attempts.get(id)?.phase === "sending"
        )
          return;
        if (phase(row) === "elsewhere") adopt(store, row);
        const edit: Edit = { row, scope: session.scope };
        editing.set(id, edit);
        changed();
        const close = () => {
          if (editing.get(id) !== edit) return;
          editing.delete(id);
          changed();
        };
        return {
          content: row.message.text,
          cancel: close,
          save(text: string) {
            if (editing.get(id) !== edit || !storage)
              throw new Error("This edit is no longer available.");
            if (!text.trim() && !row.message.attachments.length)
              throw new Error("Enter a message or keep an attachment.");
            return store.locked(id, () => {
              const current = store.row(id);
              if (editing.get(id) !== edit)
                throw new Error("This edit is no longer available.");
              if (!current)
                throw new Error(
                  "This message has already been sent or removed. Your edit has been kept.",
                );
              if (current.message.text !== row.message.text)
                throw new Error(
                  "This message changed in another window. Your edit has been kept.",
                );
              store.save({
                ...current,
                message: { ...current.message, text },
              });
              close();
            });
          },
        };
      });
    },
    remove(id: string) {
      storage?.remove(id);
      attempts.delete(id);
      editing.delete(id);
      changed();
    },
    /** Disposal never publishes or drops: saved rows come back paused. */
    dispose() {
      unbind?.();
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      owners.dispose();
      listeners.clear();
    },
  };
}
export type TeamQueue = ReturnType<typeof createTeamQueue>;
