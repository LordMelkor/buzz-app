import type { OutgoingMessage } from "../../features/messages/outgoing-message";

/** A held message, saved before the gate keeps it. `owner` is the window
 * that releases it on its own; a row whose owner closed waits for Send. */
export type SavedRow = Readonly<{
  id: string;
  createdAt: number;
  owner: string;
  message: OutgoingMessage;
}>;
/** A released row's message, which holds that agent's later rows until the
 * agent has handled it. */
export type Handoff = Readonly<{ row: string; message: string; owner: string }>;

const base = "buzz-team-follow-ups.v1:";
const storageKey = (parts: readonly string[]) => base + JSON.stringify(parts);
const parts = (key: string | null) => {
  if (!key?.startsWith(base)) return;
  try {
    const value: unknown = JSON.parse(key.slice(base.length));
    return Array.isArray(value) &&
      value.every((part) => typeof part === "string")
      ? (value as string[])
      : undefined;
  } catch {
    return;
  }
};
const read = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const isRow = (value: unknown): value is SavedRow => {
  const row = value as SavedRow | null;
  return (
    !!row &&
    typeof row.id === "string" &&
    typeof row.createdAt === "number" &&
    typeof row.owner === "string" &&
    !!row.message &&
    typeof row.message.channelId === "string" &&
    typeof row.message.text === "string" &&
    Array.isArray(row.message.recipients)
  );
};

/** True for a storage event about any team follow-up record. */
export const ownsStorageKey = (key: string | null) =>
  key === null || !!parts(key);

/** Rows and handoffs for one account and community, one localStorage key
 * each, so windows never overwrite each other's records. */
export function rowStorage(scope: string) {
  const row = (id: string) => storageKey([scope, "row", id]);
  const handoff = (channelId: string, agent: string) =>
    storageKey([scope, "handoff", channelId, agent]);
  return {
    rows(): SavedRow[] {
      const rows: SavedRow[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        const [owner, kind] = parts(key) ?? [];
        if (owner !== scope || kind !== "row" || !key) continue;
        const value = read(key);
        if (isRow(value)) rows.push(value);
      }
      return rows.sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
    },
    row(id: string) {
      const value = read(row(id));
      return isRow(value) ? value : undefined;
    },
    /** Throws when storage refuses the write, so nothing is held unsaved. */
    save(value: SavedRow) {
      localStorage.setItem(row(value.id), JSON.stringify(value));
    },
    remove(id: string) {
      localStorage.removeItem(row(id));
    },
    handoff(channelId: string, agent: string) {
      const value = read(handoff(channelId, agent)) as Handoff | null;
      return value &&
        typeof value.row === "string" &&
        typeof value.message === "string" &&
        typeof value.owner === "string"
        ? value
        : undefined;
    },
    handOff(channelId: string, agent: string, value: Handoff) {
      localStorage.setItem(handoff(channelId, agent), JSON.stringify(value));
    },
    retire(channelId: string, agent: string) {
      localStorage.removeItem(handoff(channelId, agent));
    },
    /** Runs `run` holding the row's Web Lock, as Solo's queue does. Every
     * window takes it to claim a row, save its edit, or check and publish
     * it, so no window sends a row another window took, changed or sent.
     * Without Web Locks (an old engine or a test page) `run` runs at once,
     * as it did before, and windows don't wait for each other. */
    locked<T>(id: string, run: () => T): T | Promise<T> {
      const locks =
        typeof navigator === "undefined" ? undefined : navigator.locks;
      return locks
        ? locks.request(`buzz-team-follow-ups-row:${row(id)}`, async () =>
            run(),
          )
        : run();
    },
  };
}
export type RowStorage = ReturnType<typeof rowStorage>;

/** This window's identity, held as a Web Lock until disposal or close, and a
 * watch on other windows' locks, so a row whose window closed shows paused. */
export function windowOwners(onClosed: () => void) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const name = `buzz-team-follow-ups-window:${crypto.randomUUID()}`;
  const abort = new AbortController();
  let release: (() => void) | undefined;
  void locks
    ?.request(
      name,
      { signal: abort.signal },
      () => new Promise<void>((resolve) => (release = resolve)),
    )
    .catch(() => {});
  const closed = new Set<string>();
  const watched = new Set<string>();
  return {
    name,
    /** Unknown windows are live until their lock frees; without Web Locks
     * no other window can be confirmed, so their rows wait for Send. */
    live(owner: string) {
      if (owner === name) return true;
      if (!locks || closed.has(owner)) return false;
      if (!watched.has(owner)) {
        watched.add(owner);
        void locks
          .request(owner, { signal: abort.signal }, () => {
            closed.add(owner);
            onClosed();
          })
          .catch(() => {});
      }
      return true;
    },
    dispose() {
      abort.abort();
      release?.();
    },
  };
}
