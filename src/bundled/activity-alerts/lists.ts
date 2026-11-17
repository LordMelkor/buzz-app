/** A device-local list of ids under one key per scope: people per account,
 * channels per community and account. Reads come from storage each time, so
 * another window's change applies here; snapshots stay stable until the
 * stored text changes. */
export type AlertList = Readonly<{
  get(scope: string): readonly string[];
  has(scope: string, id: string): boolean;
  /** False when the list is full or the choice could not be saved. */
  set(scope: string, id: string, on: boolean): boolean;
  clear(scope: string): boolean;
  subscribe(listener: () => void): () => void;
}>;

export const MAX_ENTRIES = 200;
const none: readonly string[] = Object.freeze([]);

/** This device's storage; a host without it keeps no list. */
const storage = () =>
  typeof localStorage === "undefined" ? undefined : localStorage;

function createAlertList(
  prefix: string,
  valid: (id: string) => boolean,
): AlertList {
  const cache = new Map<string, { raw: string; ids: readonly string[] }>();
  const listeners = new Set<() => void>();
  const key = (scope: string) => `${prefix}:${scope}`;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const get = (scope: string) => {
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(key(scope)) ?? null;
    } catch {
      // Unreadable storage reads as an empty list.
    }
    if (raw === null) return none;
    const cached = cache.get(scope);
    if (cached?.raw === raw) return cached.ids;
    let ids = none;
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value))
        ids = Object.freeze(
          [...new Set(value)]
            .filter((id): id is string => typeof id === "string" && valid(id))
            .slice(0, MAX_ENTRIES),
        );
    } catch {
      // A damaged value reads as an empty list until the next save.
    }
    cache.set(scope, { raw, ids });
    return ids;
  };
  const save = (scope: string, ids: readonly string[]) => {
    try {
      const local = storage();
      if (!local) return false;
      if (ids.length) local.setItem(key(scope), JSON.stringify(ids));
      else local.removeItem(key(scope));
    } catch {
      return false;
    }
    notify();
    return true;
  };
  return Object.freeze({
    get,
    has: (scope: string, id: string) => get(scope).includes(id),
    set(scope: string, id: string, on: boolean) {
      if (!valid(id)) return false;
      const rest = get(scope).filter((item) => item !== id);
      if (on && rest.length >= MAX_ENTRIES) return false;
      return save(scope, on ? [...rest, id] : rest);
    },
    clear: (scope: string) => save(scope, []),
    subscribe(listener: () => void) {
      listeners.add(listener);
      const changed = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith(`${prefix}:`))
          listener();
      };
      globalThis.addEventListener?.("storage", changed);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", changed);
      };
    },
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** People whose posts notify, per account. */
export const peopleList = () =>
  createAlertList("buzz-activity-alerts.people.v1", (id) => HEX64.test(id));
/** Channels that notify on all activity, per community and account. */
export const channelList = () =>
  createAlertList("buzz-activity-alerts.channels.v1", (id) =>
    CHANNEL_ID.test(id),
  );
