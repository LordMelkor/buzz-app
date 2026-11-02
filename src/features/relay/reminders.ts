// NIP-ER reminders (kind 30300): the viewer's self-encrypted, replaceable reminder list.
// Encryption and signing stay in the host; this owner sees only decoded intent.
import { retryRead } from "./read-retry";
import type { ReadFilter, RelayEvent } from "./events";

export const REMINDER_KIND = 30300;

/** Buzz's target dialect, shared with beta desktop and mobile (not the NIP-ER spec shape). */
export type ReminderTarget = Readonly<{
  eventId: string;
  channelId: string;
  preview: string;
  authorPubkey: string;
}>;
export type ReminderStatus = "pending" | "done" | "cancelled";
export type Reminder = Readonly<{
  /** The `d` coordinate. */
  id: string;
  eventId: string;
  createdAt: number;
  /** Due time in unix seconds; absent once done or cancelled. */
  notBefore?: number;
  status: ReminderStatus;
  target?: ReminderTarget;
  note?: string;
}>;
export type RemindersState = Readonly<{
  status: "loading" | "ready" | "error";
  /** True once the first page of a history read has landed; later pages may
   * still be loading. Local saves and live arrivals don't count. */
  hydrated: boolean;
  reminders: readonly Reminder[];
  error?: string;
}>;
export type ReminderIntent = Readonly<{
  d: string;
  createdAt: number;
  notBefore?: number;
  expiration?: number;
  content: Readonly<{
    target?: ReminderTarget;
    note?: string;
    status: ReminderStatus;
  }>;
}>;
/** Purpose-bound host codec: decode only own 30300s, sign only reminder intent. */
export type ReminderHost = Readonly<{
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<readonly { eventId: string; content: unknown }[]>;
  sign(intent: ReminderIntent, signal: AbortSignal): Promise<RelayEvent>;
}>;
export type Reminders = Readonly<{
  snapshot(): RemindersState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  create(
    target: ReminderTarget,
    notBefore: number,
    note?: string,
  ): Promise<void>;
  snooze(id: string, notBefore: number): Promise<void>;
  complete(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}>;

/** Mirrors the relay's validator: ASCII digits, no leading zero, safe integer. */
export function parseNotBefore(raw: string | undefined): number | undefined {
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

const text = (value: unknown): value is string => typeof value === "string";

/** Off-shape plaintext fails closed, as NIP-ER requires. */
export function parseReminder(
  event: RelayEvent,
  content: unknown,
): Reminder | undefined {
  const id = event.tags.find(([name]) => name === "d")?.[1];
  if (!id || !content || typeof content !== "object" || Array.isArray(content))
    return undefined;
  const data = content as Record<string, unknown>;
  const status = data.status;
  if (status !== "pending" && status !== "done" && status !== "cancelled")
    return undefined;
  if (data.note !== undefined && !text(data.note)) return undefined;
  let target: ReminderTarget | undefined;
  if (data.target !== undefined) {
    const t = data.target as Record<string, unknown> | null;
    if (
      !t ||
      typeof t !== "object" ||
      !text(t.eventId) ||
      !text(t.channelId) ||
      !text(t.preview) ||
      !text(t.authorPubkey)
    )
      return undefined;
    target = Object.freeze({
      eventId: t.eventId,
      channelId: t.channelId,
      preview: t.preview,
      authorPubkey: t.authorPubkey,
    });
  }
  if (!target && !data.note) return undefined;
  const notBefore = parseNotBefore(
    event.tags.find(([name]) => name === "not_before")?.[1],
  );
  return Object.freeze({
    id,
    eventId: event.id,
    createdAt: event.created_at,
    status,
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(target ? { target } : {}),
    ...(text(data.note) ? { note: data.note } : {}),
  });
}

function randomD() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// Status is encrypted, so every head must be read to find the pending ones.
// Handled ones carry a 30-90 day `expiration` the relay does not enforce yet,
// so the list grows with use: a few reminders a day reaches 2,000 heads in
// under two years. Past the bound the read is partial: the newest heads show
// under "Some reminders could not be loaded", older ones stay hidden, the
// plugin's saved check time stays put (so reminders due since then notify
// again each launch), and every refresh walks all the pages again. Fifty pages
// keeps that safety net, which the cursor guard already backs, out of an
// everyday user's reach.
const PAGE = 200;
const MAX_PAGES = 50;

const now = () => Math.floor(Date.now() / 1000);
/** Completed records expire 30–90 days out, randomized (NIP-ER). */
const expiration = () => now() + (30 + Math.floor(Math.random() * 60)) * 86_400;

export function createReminders(options: {
  viewer: string;
  host: ReminderHost;
  query(filters: ReadFilter[], signal: AbortSignal): Promise<RelayEvent[]>;
  publish(event: RelayEvent, signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
}) {
  const { viewer, host, signal } = options;
  const heads = new Map<string, Reminder>();
  const listeners = new Set<() => void>();
  let state: RemindersState = Object.freeze({
    status: "loading",
    hydrated: false,
    reminders: [],
  });
  let loading: Promise<void> | undefined;
  // Until the live connection is established, and again from each drop, no read
  // can mark the list ready (a failed one still reports `ready` with `error`,
  // which never counts as complete). Recovery bumps the generation, so only a
  // read started after (re-)establishment can. Offline reads still load the list.
  let offline = true;
  let generation = 0;
  let refreshController: AbortController | undefined;
  let loadingGeneration = -1;
  const publishState = (
    next: Omit<RemindersState, "reminders" | "hydrated">,
    hydrated = state.hydrated,
  ) => {
    state = Object.freeze({
      ...next,
      hydrated,
      reminders: Object.freeze([...heads.values()]),
    });
    for (const listener of listeners) listener();
  };
  // A save or live edit changes the list, not the state of the last read.
  const publishChange = () =>
    publishState({
      status: state.status === "error" ? "ready" : state.status,
      ...(state.error ? { error: state.error } : {}),
    });
  // The relay's replaceable rule: newest created_at wins, then the lowest event id.
  const merge = (reminder: Reminder) => {
    const current = heads.get(reminder.id);
    if (
      current &&
      (current.createdAt > reminder.createdAt ||
        (current.createdAt === reminder.createdAt &&
          current.eventId <= reminder.eventId))
    )
      return false;
    heads.set(reminder.id, reminder);
    return true;
  };
  async function accept(events: readonly RelayEvent[]) {
    // An event already held as a head (the one past the previous page, a live
    // echo of an own write) decodes to the head it is; skip the decrypt.
    const held = (event: RelayEvent) => {
      const d = event.tags.find(([name]) => name === "d")?.[1];
      return d !== undefined && heads.get(d)?.eventId === event.id;
    };
    const own = events.filter(
      (event) =>
        event.kind === REMINDER_KIND && event.pubkey === viewer && !held(event),
    );
    if (!own.length) return false;
    const byId = new Map(own.map((event) => [event.id, event]));
    const decoded = await host.decode(own, signal);
    signal.throwIfAborted();
    let changed = false;
    for (const { eventId, content } of decoded) {
      const event = byId.get(eventId);
      const reminder = event && parseReminder(event, content);
      if (reminder && merge(reminder)) changed = true;
    }
    return changed;
  }
  // Edits to one coordinate run in order, each building on the previous result.
  const queues = new Map<string, Promise<void>>();
  function replace(
    id: string,
    next: (current: Reminder) => Omit<ReminderIntent, "d" | "createdAt">,
  ) {
    const run = (queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = heads.get(id);
        if (!current) throw new Error("Reminder not found");
        await write({
          ...next(current),
          d: id,
          createdAt: Math.max(now(), current.createdAt + 1),
        });
      });
    queues.set(id, run);
    void run
      .finally(() => {
        if (queues.get(id) === run) queues.delete(id);
      })
      .catch(() => {});
    return run;
  }
  async function write(intent: ReminderIntent) {
    const event = await host.sign(intent, signal);
    await options.publish(event, signal);
    if (await accept([event])) publishChange();
  }
  const content = (current: Reminder, status: ReminderStatus) => ({
    ...(current.target ? { target: current.target } : {}),
    ...(current.note !== undefined ? { note: current.note } : {}),
    status,
  });
  const capability: Reminders = Object.freeze({
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh() {
      if (loading && loadingGeneration === generation) return loading;
      const current = generation;
      const controller = new AbortController();
      refreshController = controller;
      const readSignal = AbortSignal.any([signal, controller.signal]);
      loadingGeneration = current;
      if (state.status !== "loading") publishState({ status: "loading" });
      let read: Promise<void> | undefined;
      read = (async () => {
        try {
          let cursor: { until: number; before_id: string } | undefined;
          for (let pages = 1; ; pages++) {
            const events = await retryRead(
              (signal) =>
                options.query(
                  [
                    {
                      kinds: [REMINDER_KIND],
                      authors: [viewer],
                      limit: PAGE + 1,
                      ...cursor,
                    },
                  ],
                  signal,
                ),
              readSignal,
            );
            // A disposed session's late reply, even an empty one, proves nothing.
            if (signal.aborted) return;
            // Relay query order is time descending, then ID ascending (also at
            // ties), compared as the relay and `merge` do. One event past the
            // page tells a full page from the end of the list; it lands now and
            // heads the next page, where `accept` already holds it.
            const ordered = [...events].sort(
              (a, b) =>
                b.created_at - a.created_at ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            );
            const more = ordered.length > PAGE;
            const changed = await accept(events);
            if (signal.aborted || current !== generation) return;
            // Earlier pages show while later ones load; only the last can end it.
            if (!more && !offline) publishState({ status: "ready" }, true);
            else if (changed || !state.hydrated)
              publishState({ status: "loading" }, true);
            if (!more) return;
            if (pages === MAX_PAGES)
              throw new Error("Too many reminders to load");
            const last = ordered[PAGE - 1];
            if (
              !last ||
              (cursor &&
                (last.created_at > cursor.until ||
                  (last.created_at === cursor.until &&
                    last.id <= cursor.before_id)))
            )
              throw new Error("Reminder paging did not advance");
            cursor = { until: last.created_at, before_id: last.id };
          }
        } catch (error) {
          if (signal.aborted || current !== generation) return;
          publishState({
            status: heads.size ? "ready" : "error",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (loading === read) loading = undefined;
          if (refreshController === controller) refreshController = undefined;
        }
      })();
      loading = read;
      return loading;
    },
    create: (target, notBefore, note) =>
      write({
        d: randomD(),
        createdAt: now(),
        notBefore,
        content: {
          target,
          ...(note?.trim() ? { note: note.trim() } : {}),
          status: "pending",
        },
      }),
    snooze: (id, notBefore) =>
      replace(id, (current) => ({
        notBefore,
        content: content(current, "pending"),
      })),
    complete: (id) =>
      replace(id, (current) => ({
        expiration: expiration(),
        content: content(current, "done"),
      })),
    cancel: (id) =>
      replace(id, (current) => ({
        expiration: expiration(),
        content: content(current, "cancelled"),
      })),
  });
  return {
    capability,
    /** The connection dropped: the list is stale until `recover()`'s read lands. */
    stale() {
      offline = true;
      if (state.status !== "loading") publishState({ status: "loading" });
    },
    /** The connection is (re-)established: start the read that ends the outage. */
    recover() {
      offline = false;
      generation++;
      refreshController?.abort();
      return capability.refresh();
    },
    /** Live delivery from another device; failures leave the last good list. */
    receive(events: readonly RelayEvent[]) {
      void accept(events)
        .then((changed) => {
          if (changed) publishChange();
        })
        .catch(() => {});
    },
  };
}
