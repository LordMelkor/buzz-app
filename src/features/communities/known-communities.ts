// Durable known-community sync state. Pure: every function returns a new
// state and never touches storage, sessions or the network. The service keeps
// this beside the memberships in the one device record, so a membership change
// and the intent to upload it are a single write. Destinations are keyed by the
// account service's `wss://host[:port]` spelling (see `relayAddress`).
import { relayAddress } from "./destination";

/** One intent awaiting upload: the latest word on its destination. A newer
 * intent replaces it outright, which is safe because the service's add and
 * remove are idempotent: whichever of them lands last is the state. */
export type PendingOp = { url: string; removed: boolean };
export type SyncState = {
  /** The destinations the service has been seen to hold for `account`:
   * every one it has listed or accepted an add for, less the removals it has
   * accepted from here. A list that omits one does not drop it, because a
   * removal made elsewhere is deliberately ignored for now: the membership
   * stays saved on this device and, being known, is never uploaded again. */
  known: string[];
  outbox: PendingOp[];
  /** The Builderlab account (its subject) whose list `known` describes.
   * Absent until a first merge. The record outlives a Builderlab sign-out, so
   * a sign-in as another account must not read this set as that account's. */
  account?: string;
};

export const emptySync = (): SyncState => ({ known: [], outbox: [] });

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("wss://");

/** Reads the saved `sync` field. Records from before this field existed, or
 * ones this reader cannot understand, read as empty, and a malformed entry is
 * dropped on its own. */
export function parseSync(raw: unknown): SyncState {
  if (!raw || typeof raw !== "object") return emptySync();
  const { known, outbox, account } = raw as Record<string, unknown>;
  return {
    ...(typeof account === "string" && account ? { account } : {}),
    known: Array.isArray(known) ? [...new Set(known.filter(isAddress))] : [],
    outbox: Array.isArray(outbox)
      ? outbox.flatMap((op): PendingOp[] =>
          op &&
          typeof op === "object" &&
          "url" in op &&
          isAddress(op.url) &&
          "removed" in op &&
          typeof op.removed === "boolean"
            ? [{ url: op.url, removed: op.removed }]
            : [],
        )
      : [],
  };
}

/** Records a new intent for a destination, replacing any older one. Nothing
 * is queued when the latest word already says so: the pending intent, or the
 * service holding the destination. Removing a destination the service is not
 * known to hold still queues, in case another device saved it. */
export function enqueue(
  state: SyncState,
  url: string,
  removed: boolean,
): SyncState {
  const pending = state.outbox.find((op) => op.url === url);
  const latest = pending
    ? pending.removed
    : state.known.includes(url)
      ? false
      : undefined;
  if (latest === removed) return state;
  return {
    ...state,
    outbox: [...state.outbox.filter((op) => op.url !== url), { url, removed }],
  };
}

/** The service accepted `op`: it now holds the destination or no longer does.
 * The intent leaves the outbox unless a different one has replaced it since. */
export function acknowledge(state: SyncState, op: PendingOp): SyncState {
  const held = state.known.includes(op.url);
  return {
    ...state,
    known: op.removed
      ? held
        ? state.known.filter((url) => url !== op.url)
        : state.known
      : held
        ? state.known
        : [...state.known, op.url],
    outbox: state.outbox.filter(
      (entry) => entry.url !== op.url || entry.removed !== op.removed,
    ),
  };
}

/** Reconciles `account`'s complete server list with the device's
 * memberships. The list joins what is known. A destination the service has
 * that the device lacks is added unless its removal is queued; a saved
 * membership the service has never seen is queued for upload, which is how a
 * device list from before sync existed reaches the account. A saved
 * membership the service knew but no longer lists is left alone: not
 * forgotten (removals made elsewhere are ignored for now) and, still known,
 * not uploaded again, so this device never undoes the other's removal. What
 * was known describes only the account it was merged for: another account's
 * list, or one merged before the account was recorded, starts from nothing
 * known, so it uploads every membership it lacks. */
export function mergeList(
  state: SyncState,
  memberships: ReadonlyArray<{ id: string }>,
  list: string[],
  account: string,
): { state: SyncState; add: string[] } {
  const before = state.account === account ? state.known : [];
  const known = [...new Set([...before, ...list])];
  const local = new Set(memberships.map((m) => relayAddress(m.id)));
  const pending = new Map(state.outbox.map((op) => [op.url, op]));
  const add = [...new Set(list)].filter(
    (url) => !local.has(url) && !pending.get(url)?.removed,
  );
  let next: SyncState = { known, outbox: state.outbox, account };
  for (const url of local)
    if (!known.includes(url) && !pending.has(url))
      next = enqueue(next, url, false);
  return { state: next, add };
}
