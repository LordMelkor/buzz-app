import { expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryListing } from "../agents/memory";
import {
  MemoryReads,
  NOTE_LIMIT,
  coreMemorySection,
  coreOf,
  recentNotesSection,
} from "./core-memory";

const agent = "a".repeat(64);
const core: MemoryEntry = {
  slug: "core",
  body: "I am Claude.",
  eventId: "e".repeat(64),
  createdAt: 1,
};
const listing = (
  entries: readonly MemoryEntry[],
  partial = false,
): MemoryListing => ({ entries, partial });

/** A connection whose reads wait until the test settles them. They ignore
 * their abort signal, as the native reader does while it waits on the host. */
function session() {
  const pending: ((value: MemoryListing) => void)[] = [];
  const read = vi.fn(
    () =>
      new Promise<MemoryListing>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    read,
    settle: (index: number, value: MemoryListing) => pending[index]?.(value),
    source: { connection: {}, memoryListing: read },
  };
}

it("shares a read between concurrent callers, and reads again once it settles", async () => {
  const s = session();
  const reads = new MemoryReads();
  const first = reads.read(s.source, agent, new AbortController().signal);
  const second = reads.read(s.source, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(1);
  s.settle(0, listing([core]));
  await expect(Promise.all([first, second])).resolves.toEqual([
    listing([core]),
    listing([core]),
  ]);
  const later = reads.read(s.source, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  s.settle(1, listing([]));
  await expect(later).resolves.toEqual(listing([]));
});

it("does not share a read that started before a write", async () => {
  const s = session();
  const reads = new MemoryReads();
  const stale = reads.read(s.source, agent, new AbortController().signal);
  reads.forget(s.source.connection, agent);
  const fresh = reads.read(s.source, agent, new AbortController().signal);
  const shared = reads.read(s.source, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  // The stale read settling first must not drop the fresh one.
  s.settle(0, listing([core]));
  await stale;
  reads.read(s.source, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  const renamed = listing([{ ...core, body: "I am Claude, renamed." }]);
  s.settle(1, renamed);
  await expect(Promise.all([fresh, shared])).resolves.toEqual([
    renamed,
    renamed,
  ]);
});

it("shares reads per slug, and a write forgets every read of the agent", async () => {
  const s = session();
  const reads = new MemoryReads();
  const signal = new AbortController().signal;
  void reads.read(s.source, agent, signal, "core");
  void reads.read(s.source, agent, signal);
  void reads.read(s.source, agent, signal, "core");
  expect(s.read.mock.calls.map((call) => call.at(1))).toEqual([
    "core",
    undefined,
  ]);
  reads.forget(s.source.connection, agent);
  void reads.read(s.source, agent, signal, "core");
  void reads.read(s.source, agent, signal);
  expect(s.read).toHaveBeenCalledTimes(4);
});

it("stops waiting when the caller aborts, even if the read does not", async () => {
  const s = session();
  const reads = new MemoryReads();
  const controller = new AbortController();
  const waiting = reads.read(s.source, agent, controller.signal);
  const other = reads.read(s.source, agent, new AbortController().signal);
  controller.abort(new Error("turn ended"));
  await expect(waiting).rejects.toThrow("turn ended");
  s.settle(0, listing([core]));
  await expect(other).resolves.toEqual(listing([core]));
  await expect(
    reads.read(s.source, agent, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(s.read).toHaveBeenCalledTimes(1);
});

it("stops a read once every caller sharing it has stopped waiting", async () => {
  const signals: AbortSignal[] = [];
  const read = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<MemoryListing>(() => {});
  });
  const source = { connection: {}, memoryListing: read };
  const reads = new MemoryReads();
  const first = new AbortController();
  const second = new AbortController();
  const waiting = [
    reads.read(source, agent, first.signal),
    reads.read(source, agent, second.signal),
  ];
  for (const wait of waiting) wait.catch(() => {});
  // One caller leaving does not cancel the read the other still wants.
  first.abort(new Error("first left"));
  await expect(waiting[0]).rejects.toThrow("first left");
  expect(signals[0]?.aborted).toBe(false);
  second.abort(new Error("second left"));
  await expect(waiting[1]).rejects.toThrow("second left");
  expect(signals[0]?.aborted).toBe(true);
  // A later caller starts a read of its own rather than joining the stopped one.
  void reads.read(source, agent, new AbortController().signal).catch(() => {});
  expect(read).toHaveBeenCalledTimes(2);
  expect(signals[1]?.aborted).toBe(false);
});

it("finds core memory, none, or nothing certain in a partial listing", () => {
  expect(coreOf(listing([core]))).toBe("I am Claude.");
  expect(coreOf(listing([core], true))).toBe("I am Claude.");
  expect(coreOf(listing([]))).toBeNull();
  expect(coreOf(listing([], true))).toBeUndefined();
});

it("shows core memory, prompts for one when there is none, and omits unknown", () => {
  expect(coreMemorySection(" I am Claude.\n")).toBe(
    "<core-memory>\nI am Claude.\n</core-memory>",
  );
  expect(coreMemorySection(null)).toContain("No core memory found.");
  expect(coreMemorySection(undefined)).toBe("");
  expect(coreMemorySection("  ")).toBe("");
});

it("shows yesterday's and today's notes, oldest first, by this device's dates", async () => {
  const note = (slug: string, body: string) => ({ ...core, slug, body });
  const read = vi.fn(async (slug: string) =>
    listing(
      slug === "mem/notes/2026-02-28"
        ? [note(slug, "Ada likes tea.\n")]
        : slug === "mem/notes/2026-03-01"
          ? [note(slug, "Ada moved to Leeds.")]
          : [],
    ),
  );
  // Just after midnight on the 1st: yesterday is the last day of February.
  const now = new Date(2026, 2, 1, 0, 5);
  expect(await recentNotesSection(read, now)).toBe(
    [
      "<recent-notes>",
      '<note slug="mem/notes/2026-02-28">',
      "Ada likes tea.",
      "</note>",
      '<note slug="mem/notes/2026-03-01">',
      "Ada moved to Leeds.",
      "</note>",
      "</recent-notes>",
    ].join("\n"),
  );
  expect(read.mock.calls.map(([slug]) => slug)).toEqual([
    "mem/notes/2026-02-28",
    "mem/notes/2026-03-01",
  ]);
});

it("adds nothing for a missing, blank or unread note", async () => {
  const now = new Date(2026, 9, 30, 12);
  expect(await recentNotesSection(async () => listing([]), now)).toBe("");
  expect(await recentNotesSection(async () => listing([], true), now)).toBe("");
  expect(
    await recentNotesSection(
      async (slug) => listing([{ ...core, slug, body: " \n" }]),
      now,
    ),
  ).toBe("");
  expect(
    await recentNotesSection(async () => {
      throw new Error("Buzz is not connected");
    }, now),
  ).toBe("");
  // One read failing still shows the other note.
  expect(
    await recentNotesSection(async (slug) => {
      if (slug.endsWith("29")) throw new Error("timed out");
      return listing([{ ...core, slug, body: "Today." }]);
    }, now),
  ).toContain('<note slug="mem/notes/2026-10-30">\nToday.\n</note>');
});

it("keeps the newest part of a long note, cut where a character starts", async () => {
  // "é" is two bytes, so the limit falls inside one.
  const body = `${"old\n".repeat(10)}${"é".repeat(NOTE_LIMIT / 2)}x`;
  const section = await recentNotesSection(
    async (slug) =>
      slug.endsWith("30") ? listing([{ ...core, slug, body }]) : listing([]),
    new Date(2026, 9, 30, 12),
  );
  const kept = section.split("\n")[3] ?? "";
  expect(section.split("\n")[2]).toBe("[older part of this note left out]");
  expect(kept).toBe(`${"é".repeat(NOTE_LIMIT / 2 - 1)}x`);
  expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(NOTE_LIMIT);
  expect(section).not.toContain("old\n");
});
