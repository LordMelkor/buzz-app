// An agent's memory as the harness plugins read it and show it to their
// agents, through the reads of the agent's community.
import type { AgentReads, MemoryListing } from "../agents/reads";

/** How long a shared read may take; each caller can stop waiting sooner. It
 * matches the frontend's bound on the native read, which answers a slow
 * listing partial within it. */
export const READ_TIMEOUT_MS = 10_000;

/** One read per connection, agent and slug (or full listing) at a time, which
 * concurrent turns and tool calls share. A new connection, even to the same community, may read as
 * someone else, so it shares nothing with an old one. A read stops once every
 * caller sharing it has stopped waiting. */
export class MemoryReads {
  private reads = new WeakMap<object, Map<string, Shared>>();

  async read(
    source: Pick<AgentReads, "connection" | "memoryListing">,
    agent: string,
    signal: AbortSignal,
    slug?: string,
  ) {
    signal.throwIfAborted();
    let reads = this.reads.get(source.connection);
    if (!reads) {
      reads = new Map();
      this.reads.set(source.connection, reads);
    }
    const key = `${agent}\0${slug ?? ""}`;
    let read = reads.get(key);
    if (!read) {
      const stop = new AbortController();
      const started: Shared = {
        listing: source.memoryListing(
          AbortSignal.any([stop.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
          slug,
        ),
        stop,
        callers: 0,
      };
      const shared = reads;
      const done = () => {
        if (shared.get(key) === started) shared.delete(key);
      };
      void started.listing.then(done, done);
      reads.set(key, started);
      read = started;
    }
    // The last caller to stop waiting stops the read, which a later caller
    // then starts afresh.
    const joined = read;
    const table = reads;
    const leave = () => {
      joined.callers -= 1;
      if (joined.callers > 0) return;
      joined.stop.abort(signal.reason);
      if (table.get(key) === joined) table.delete(key);
    };
    joined.callers += 1;
    signal.addEventListener("abort", leave, { once: true });
    return abortable(joined.listing, signal).finally(() =>
      signal.removeEventListener("abort", leave),
    );
  }

  /** After a memory write, a read that may have started before it is not
   * shared with later callers. */
  forget(connection: object, agent: string) {
    const reads = this.reads.get(connection);
    for (const key of reads?.keys() ?? [])
      if (key.startsWith(`${agent}\0`)) reads?.delete(key);
  }
}

type Shared = {
  listing: Promise<MemoryListing>;
  stop: AbortController;
  /** The callers still waiting for it. */
  callers: number;
};

/** The `core` memory in a listing (best read alone, by slug): its text, `null` when the agent has none,
 * or undefined when a partial listing may have missed it. */
export function coreOf(listing: MemoryListing) {
  return (
    listing.entries.find((entry) => entry.slug === "core")?.body ??
    (listing.partial ? undefined : null)
  );
}

/** The `core` memory section of a prompt: its text, a prompt to create one
 * when it is `null`, or nothing when it is unread (`undefined`) or blank. */
export function coreMemorySection(memory: string | null | undefined) {
  const body =
    memory === null
      ? "No core memory found. Use `mem_set` with slug `core` to create one (it will hold your identity, lessons, and goals across sessions). Ask your user about yourself."
      : memory?.trim();
  return body ? `<core-memory>\n${body}\n</core-memory>` : "";
}

/** The most of each note `recentNotesSection` shows, in UTF-8 bytes. */
export const NOTE_LIMIT = 8 * 1024;

/** Yesterday's and today's `mem/notes/<date>` notes, in a section of a prompt.
 * Dates are this device's, which JS takes as UTC when it has no time zone.
 * Notes are appended to, so a long one keeps its end. A note that is missing,
 * blank or unread adds nothing. */
export async function recentNotesSection(
  read: (slug: string) => Promise<MemoryListing>,
  now = new Date(),
) {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const notes = await Promise.all(
    [yesterday, now].map(async (day) => {
      const slug = `mem/notes/${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
      const body = await read(slug).then(
        (listing) =>
          listing.entries.find((entry) => entry.slug === slug)?.body.trim(),
        () => undefined,
      );
      return body ? `<note slug="${slug}">\n${tail(body)}\n</note>` : "";
    }),
  );
  const body = notes.filter(Boolean).join("\n");
  return body ? `<recent-notes>\n${body}\n</recent-notes>` : "";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The last `NOTE_LIMIT` bytes of `text`, cut where a character starts. */
function tail(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= NOTE_LIMIT) return text;
  let start = bytes.length - NOTE_LIMIT;
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return `[older part of this note left out]\n${new TextDecoder().decode(bytes.subarray(start))}`;
}

/** Stops waiting when `signal` aborts, even if the read itself does not. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
