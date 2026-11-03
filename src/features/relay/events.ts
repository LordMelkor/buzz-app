import {
  getEventHash,
  verifyEvent,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";
import { ByteLru } from "./budget.ts";
/** A relay event whose signature has been verified at the transport boundary. */
export type RelayEvent = VerifiedEvent;
/** Event payload shared by locally authored intent and verified relay records.
 * Only RelayEvent carries signature verification; local intent never establishes relay authority. */
export type EventData = Readonly<
  Pick<RelayEvent, "id" | "pubkey" | "created_at" | "kind" | "content" | "tags">
>;
export type ReadFilter = Readonly<{
  kinds?: readonly number[];
  ids?: readonly string[];
  /** NIP-01 single-letter tag filters, including references (#e/#a) and topics (#t). */
  [tag: `#${string}`]: readonly string[] | undefined;
  limit: number;
  authors?: readonly string[];
  /** Read from the writer when resolving uncertain publication or admission. */
  consistency?: "strong";
  /** NIP-AR artifact reads: current heads only, or a `d`'s revision history. */
  artifact?: "current" | "history";
  /** NIP-AR artifact page offset (≤ 10,000). */
  offset?: number;
  until?: number;
  since?: number;
  "#h"?: readonly string[];
  "#d"?: readonly string[];
  "#p"?: readonly string[];
  /** Buzz relay extensions for channel history windows. */
  top_level?: boolean;
  include_aux?: boolean;
  include_summaries?: boolean;
  before_id?: string;
  /** HTTP bridge finite search, home-feed, and thread traversal extensions. */
  search?: string;
  search_mode?: "prefix" | "fulltext";
  /** Only for relays advertising `buzz-search-sort`. */
  search_sort?: "newest";
  page?: number;
  feed_types?: readonly string[];
  thread_window?: boolean;
  depth_limit?: number;
  thread_cursor?: number;
  thread_cursor_id?: string;
}>;
// Identity-only evidence for immutable records owned by this admission boundary.
// Neither a caller-provided nostr-tools symbol nor a copied record is proof.
const admitted = new WeakSet<object>();
export function hasEventProof(event: EventData): boolean {
  return admitted.has(event);
}

export function eventDto(value: unknown): RelayEvent {
  return checkedEvent(value, verifyEvent);
}

/** A whole query response; one bad event rejects it, as relay reads do. */
export function eventsDto(value: unknown): RelayEvent[] {
  if (!Array.isArray(value))
    throw new Error("Relay response is not an event array");
  return value.map(eventDto);
}

/** Checks that each `sig` is a BIP-340 signature over `id` by `pubkey`; one result per claim. */
export type SignatureVerifier = (
  claims: readonly Readonly<Pick<Event, "id" | "pubkey" | "sig">>[],
) => Promise<readonly boolean[]>;

/** One owner's bounded proof memo (an HTTP connection, or a live subscription
 * across its reconnects), not an event/result cache. Only a matching content
 * hash AND exact signature can reuse a successful verification. Retains no
 * payload, authorization, freshness or caller-supplied proof symbols.
 * With `signatures`, `native.prepare` does the synchronous checks per event
 * and `native.settle` sends the memo misses to it in one call. */
export function createEventVerifier(
  entries = 8192,
  signatures?: SignatureVerifier,
): EventVerifier {
  // Idle sessions periodically re-read the same events. An LRU smaller than that
  // working set misses on every in-order re-read, so keep it well above it.
  const proofs = new ByteLru<string>(entries, entries * 192);
  const proven = (event: Event) => proofs.get(event.id) === event.sig;
  const remember = (event: Event) => {
    // A resume never replays an ephemeral event, so its proof would rarely hit.
    if (event.kind < 20000 || event.kind >= 30000)
      proofs.set(event.id, event.sig, 192); // fixed ASCII id (64) + signature (128)
  };
  const verify = (value: unknown): RelayEvent =>
    checkedEvent(value, (event): event is VerifiedEvent => {
      if (proven(event) && getEventHash(event) === event.id) {
        event[verifiedSymbol] = true;
        return true;
      }
      if (!verifyEvent(event)) return false;
      remember(event);
      return true;
    });
  if (!signatures) return verify;
  const prepare = (value: unknown): PreparedEvent => {
    const event = wireEvent(value);
    if (getEventHash(event) !== event.id) throw invalidEvent();
    return event as PreparedEvent;
  };
  const settle = async (
    events: readonly PreparedEvent[],
  ): Promise<RelayEvent[]> => {
    const pending = events.filter((event) => !proven(event));
    const valid = pending.length
      ? await signatures(
          pending.map(({ id, pubkey, sig }) => ({ id, pubkey, sig })),
        )
      : [];
    if (
      valid.length !== pending.length ||
      valid.some((signed) => signed !== true)
    )
      throw invalidEvent();
    pending.forEach(remember);
    return events.map((event) => {
      event[verifiedSymbol] = true;
      return admit(event as VerifiedEvent);
    });
  };
  return Object.assign(verify, { native: { prepare, settle } });
}

declare const prepared: unique symbol;
/** A well-formed wire copy whose id matches its hash; its signature is unchecked.
 * Only `native.prepare` produces one. */
export type PreparedEvent = Event & { readonly [prepared]: true };

export type EventVerifier = ((value: unknown) => RelayEvent) & {
  native?: {
    prepare(value: unknown): PreparedEvent;
    /** One bad signature rejects the whole response, as `verify` does per event. */
    settle(events: readonly PreparedEvent[]): Promise<RelayEvent[]>;
  };
};

const invalidEvent = () =>
  new Error("Relay supplied a malformed or invalidly signed event");

function checkedEvent(
  value: unknown,
  verify: (event: Event) => event is VerifiedEvent,
): RelayEvent {
  const owned = wireEvent(value);
  if (!verify(owned)) throw invalidEvent();
  return admit(owned);
}

/** The wire fields of a well-formed event, copied and not yet verified. */
function wireEvent(value: unknown): Event {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidEvent();
  const raw = value as Record<string, unknown>;
  // nostr-tools validates only typeof number here. JSON overflow becomes Infinity
  // and hashes as null; fractions/unsafe integers cannot be protocol timestamps.
  if (
    typeof raw.created_at !== "number" ||
    !Number.isSafeInteger(raw.created_at) ||
    raw.created_at < 0 ||
    typeof raw.kind !== "number" ||
    !Number.isInteger(raw.kind) ||
    raw.kind < 0 ||
    raw.kind > 65535 ||
    typeof raw.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.id) ||
    typeof raw.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.pubkey) ||
    typeof raw.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(raw.sig) ||
    typeof raw.content !== "string" ||
    !Array.isArray(raw.tags) ||
    raw.tags.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((item) => typeof item !== "string"),
    )
  )
    throw invalidEvent();
  // Copy only wire fields before verification. Never trust a cached verification
  // symbol from a caller-owned object whose signed bytes may have changed.
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    sig: raw.sig,
    created_at: raw.created_at,
    kind: raw.kind,
    content: raw.content,
    tags: raw.tags.map((tag: string[]) => [...tag]),
  };
}

function admit(owned: VerifiedEvent): RelayEvent {
  for (const tag of owned.tags) Object.freeze(tag);
  Object.freeze(owned.tags);
  Object.freeze(owned);
  admitted.add(owned);
  return owned;
}

export const tag = (event: RelayEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
export const hasTag = (event: RelayEvent, name: string, value: string) =>
  event.tags.some((entry) => entry[0] === name && entry[1] === value);

/** Later created_at wins; ties break on lower id so replay order cannot flip the result. */
export function newer<T extends Pick<EventData, "created_at" | "id">>(
  current: T | undefined,
  candidate: T,
): T {
  return !current ||
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
    ? candidate
    : current;
}
