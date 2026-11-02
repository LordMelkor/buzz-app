/** Owner-view NIP-AE snapshot from a purpose-bound key-owning host. */
import { retryRead } from "../relay/read-retry.ts";
/** Budgets of the development broker's single memory query. */
export const MEMORY_EVENT_LIMIT = 256;
export const MEMORY_WIRE_BYTES = 2 * 1024 * 1024;
export const MEMORY_TEXT_BYTES = 1024 * 1024;
/** Budgets of a listing from any host; the native host pages past the broker's
 * single query, up to the same caps. */
const LISTING_ENTRIES = 4096;
const LISTING_TEXT_BYTES = 8 * 1024 * 1024;
export interface MemoryEntry {
  slug: string;
  body: string;
  eventId: string;
  createdAt: number;
}
export interface MemoryListing {
  entries: readonly MemoryEntry[];
  /** Deleted entries' tombstones, which a write recreating one must follow. */
  deleted?: readonly Readonly<{ slug: string; createdAt: number }>[];
  partial: boolean;
}
/** Reads every entry, or only entry `slug` when given. */
export type MemoryReader = (
  agent: string,
  signal: AbortSignal,
  slug?: string,
) => Promise<MemoryListing>;
export type MemorySnapshot = Readonly<{
  status:
    | "idle"
    | "blocked"
    | "loading"
    | "ready"
    | "error"
    | "denied"
    | "unavailable";
  listing?: MemoryListing;
}>;
export function memoryAgent(agent: unknown, viewer: string): agent is string {
  return (
    typeof agent === "string" &&
    /^[0-9a-f]{64}$/.test(agent) &&
    agent !== viewer
  );
}
/** NIP-AE address grammar, shared by host evidence and renderer DTO validation. */
export function memorySlug(slug: unknown): slug is string {
  return (
    typeof slug === "string" &&
    slug.length <= 255 &&
    (slug === "core" ||
      /^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(slug))
  );
}
/** Bound bytes before parsing ciphertext or plaintext responses. */
export async function memoryResponseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Memory response missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MEMORY_WIRE_BYTES)
        throw new Error("Memory response exceeds budget");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Validate the host DTO before retaining plaintext, including aggregate size. */
export function memoryListing(input: unknown): MemoryListing {
  const value = input as MemoryListing | null;
  if (
    !value ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > LISTING_ENTRIES ||
    !Array.isArray(value.deleted ?? []) ||
    (value.deleted?.length ?? 0) > LISTING_ENTRIES
  )
    throw new Error("Invalid memory listing");
  const slugs = new Set<string>();
  let bytes = 0;
  const entries = value.entries.map((entry) => {
    if (
      !entry ||
      !memorySlug(entry.slug) ||
      typeof entry.body !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.eventId) ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      slugs.has(entry.slug)
    )
      throw new Error("Invalid memory entry");
    slugs.add(entry.slug);
    const copy = {
      slug: entry.slug,
      body: entry.body,
      eventId: entry.eventId,
      createdAt: entry.createdAt,
    };
    bytes += new TextEncoder().encode(JSON.stringify(copy)).length;
    if (bytes > LISTING_TEXT_BYTES)
      throw new Error("Memory listing exceeds budget");
    return Object.freeze(copy);
  });
  const deleted = (value.deleted ?? []).map((entry) => {
    if (
      !entry ||
      !memorySlug(entry.slug) ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      slugs.has(entry.slug)
    )
      throw new Error("Invalid memory entry");
    slugs.add(entry.slug);
    return Object.freeze({ slug: entry.slug, createdAt: entry.createdAt });
  });
  return Object.freeze({
    entries: Object.freeze(
      entries.sort((a, b) => a.slug.localeCompare(b.slug)),
    ),
    ...(deleted.length ? { deleted: Object.freeze(deleted) } : {}),
    partial: value.partial,
  });
}

/** Each mounted consumer owns a view; session retirement revokes every view. */
export function createAgentMemories(
  source: MemoryReader | undefined,
  viewer: string,
  available: () => boolean,
  notify = (listener: () => void) => listener(),
) {
  const views = new Set<ReturnType<typeof open>>();
  const reads = new Set<AbortController>();
  let closed = false;
  let generation = 0;
  let queued = Promise.resolve();
  function open(agent: string) {
    if (closed || views.size >= 4) throw new Error("Memory views unavailable");
    const eligible = memoryAgent(agent, viewer);
    let disposed = false;
    let controller: AbortController | undefined;
    let snapshot: MemorySnapshot = {
      status: source && eligible ? "idle" : "unavailable",
    };
    const listeners = new Set<() => void>();
    const publish = (next: MemorySnapshot) => {
      snapshot = Object.freeze(next);
      for (const listener of listeners) notify(listener);
    };
    const clear = () => {
      controller?.abort();
      controller = undefined;
      publish({
        status:
          disposed || closed || !source || !eligible ? "unavailable" : "idle",
      });
    };
    const view = {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh() {
        if (disposed || closed || !source || !eligible || controller) return;
        if (!available()) {
          publish({ status: "blocked" });
          return;
        }
        const owned = new AbortController();
        controller = owned;
        publish({ status: "loading" });
        try {
          owned.signal.throwIfAborted();
          const signal = AbortSignal.any([
            owned.signal,
            AbortSignal.timeout(10000),
          ]);
          const listing = memoryListing(
            await retryRead((signal) => source(agent, signal), signal),
          );
          signal.throwIfAborted();
          if (!owned.signal.aborted)
            publish(
              available()
                ? { status: "ready", listing }
                : { status: "blocked" },
            );
        } catch (error) {
          if (!owned.signal.aborted)
            publish({
              status:
                error instanceof Error && error.name === "MemoryDenied"
                  ? "denied"
                  : "error",
            });
        } finally {
          if (controller === owned) controller = undefined;
        }
      },
      clear,
      dispose() {
        disposed = true;
        clear();
        listeners.clear();
        views.delete(view);
      },
    };
    views.add(view);
    return view;
  }
  /** Runtime reads do not consume mounted-view capacity. They are serialized so
   * bursts across agents still impose one bounded owner-view read per session. */
  function read(agent: string, signal: AbortSignal, slug?: string) {
    const admitted = generation;
    const task = queued.then(async () => {
      signal.throwIfAborted();
      if (
        admitted !== generation ||
        closed ||
        !source ||
        !memoryAgent(agent, viewer) ||
        (slug !== undefined && !memorySlug(slug)) ||
        !available()
      )
        throw new Error("Memory read unavailable");
      const controller = new AbortController();
      reads.add(controller);
      try {
        const combined = AbortSignal.any([
          signal,
          controller.signal,
          AbortSignal.timeout(10000),
        ]);
        const listing = memoryListing(await source(agent, combined, slug));
        combined.throwIfAborted();
        if (admitted !== generation || !available())
          throw new Error("Memory read unavailable");
        // A source may answer a one-entry read with more.
        return slug === undefined
          ? listing
          : Object.freeze({
              ...listing,
              entries: Object.freeze(
                listing.entries.filter((entry) => entry.slug === slug),
              ),
            });
      } finally {
        reads.delete(controller);
      }
    });
    queued = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  return {
    capability: Object.freeze({ open, read }),
    clear() {
      generation++;
      for (const controller of reads) controller.abort();
      for (const view of views) view.clear();
    },
    dispose() {
      closed = true;
      generation++;
      for (const controller of reads) controller.abort();
      for (const view of views) view.dispose();
    },
  };
}
