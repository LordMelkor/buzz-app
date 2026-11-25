import { ReadError, transientStatus } from "./errors";
import { isRetryableRead, retryRead } from "./read-retry";
import { readSubthread, subthreadMessages } from "./subthread";
import {
  canonicalChannel,
  MissingThreadBounds,
  threadBounds,
  type ThreadCursor,
} from "./thread-window";
import { isThreadContent, threadReference } from "./thread-reference";
export { threadReference } from "./thread-reference";
import type { ChannelMessage } from "./contracts";
import type { EventData, ReadFilter, RelayEvent } from "./events";
import { newer } from "./events";
import type { LocalEvents } from "./outbox";
import type { Priority, RelayReader } from "./reader";
import type { RecoveryStatus } from "./recovery";
import { listByteSize } from "./budget";
import { foldMessages } from "./fold";
import { compareMessages, MessageClock } from "./message-order";
import { shareMessageRows } from "./row-identity";
import { RESUME_READ_AGE } from "./live";

const AUX = new Set([5, 7, 9005, 40003, 39005, 39006]);
const PAGE_SIZE = 50;
const INITIAL_WINDOW_SIZE = 10;
/** Resident pages. Reading past them evicts pages from the window's far end. */
const MAX_PAGES = 10;
/** Resident evidence above which far pages are evicted, never a wipe. */
const MAX_EVENTS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;
/** The relay's `thread_window` row allowlist excludes legacy diffs (kind 40008). */
const STRICT_WINDOW_KINDS = [9, 40002];
const inChannel = (event: EventData, channelId: string) =>
  event.tags.some(([name, value]) => name === "h" && value === channelId);
/** Relay thread-cursor order (seconds, id); rendered order is `compareMessages`. */
const compare = (a: ThreadCursor, b: ThreadCursor) =>
  a.created_at - b.created_at || a.id.localeCompare(b.id);

export type ThreadSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  root: ChannelMessage | undefined;
  replies: readonly ChannelMessage[];
  error: string | undefined;
  /** Continuation is possible, not a claim about total thread size or exhaustion. */
  canLoadMore: boolean;
  /** The window is full: the next continuation evicts its first page. */
  limited: boolean;
  /** Pages before the window's first were evicted and can be read again. */
  canLoadBack?: boolean;
  /** Traversal order: strict windows continue toward older replies, legacy
   * toward newer ones. */
  direction?: "older" | "forward";
  /** The in-flight or failed read, distinct from the traversal direction. */
  readKind?: "older" | "back" | "refresh" | undefined;
  /** Exact navigation target, folded independently of bounded thread traversal. */
  target?: ChannelMessage | undefined;
  targetStatus?: "loading" | "ready" | "unavailable" | "error" | undefined;
  pinnedTarget?: ChannelMessage | undefined;
  /** Rows include a closed view's resumed rows, until this view's first
   * refresh settles either way. */
  resumed?: true | undefined;
  /** History not read yet may hold the parent of a reply shown without it. */
  seeking?: true | undefined;
  /** A read failed and waits on session recovery, which retries it. */
  recovering?: true | undefined;
}>;
/** What a closed ordinary thread last showed. A view opened from it shows
 * these rows at once, as display only: they are never evidence, and the
 * view's first refresh replaces them. */
export type ThreadResume = Readonly<{
  root: ChannelMessage;
  replies: readonly ChannelMessage[];
  direction: "older" | "forward";
  canLoadMore: boolean;
  limited: boolean;
}>;
/** Every ID a deletion among these events names, valid or not. */
function deletionTargets(events: Iterable<EventData>) {
  const ids = new Set<string>();
  for (const event of events)
    if (event.kind === 5 || event.kind === 9005)
      for (const [name, id] of event.tags) if (name === "e" && id) ids.add(id);
  return ids;
}
/** A resume without the rows any of these retained events deletes. A thread
 * view admits a deletion only beside its target, so a tombstone retained
 * alone would not hide a resumed row. */
export function resumeAfter(
  resume: ThreadResume,
  events: readonly EventData[],
): ThreadResume | undefined {
  const deleted = deletionTargets(events);
  if (deleted.has(resume.root.id)) return undefined;
  const replies = resume.replies.filter((row) => !deleted.has(row.id));
  return replies.length === resume.replies.length
    ? resume
    : Object.freeze({ ...resume, replies });
}
export type ThreadRetarget =
  | "selected"
  | "different"
  | "unavailable"
  | "error"
  | "cancelled";
export type ThreadView = {
  snapshot(): ThreadSnapshot;
  subscribe(listener: () => void): () => void;
  /** Start an opted-in branch with an exact selection and its source root. */
  refresh(selection?: {
    messageId: string;
    sourceThreadId?: string | undefined;
  }): Promise<void>;
  /** Reads older replies; with `through`, keeps paging in this one read until
   * a reply at or before the time it returns is loaded. */
  loadMore(through?: () => number): Promise<void>;
  /** Read again the page evicted just before the window. */
  loadBack(): Promise<void>;
  /** Strict windows: reopen at the newest page when newer pages were evicted. */
  latest(): Promise<void>;
  /** Keep this reply loaded through eviction until it is cleared with
   * `undefined`: the parent of a reply being written. */
  pin(id: string | undefined): void;
  /** Change exact selection only when verified ancestry belongs to this thread. */
  retarget(messageId: string, signal: AbortSignal): Promise<ThreadRetarget>;
  dispose(): void;
};
/** Why an exact read can't show its target: this channel holds no such message
 * (`not-found`), or the read failed (`unavailable`). A failed thread read also
 * fails a target that is its `root`. Undefined while the read may still show it. */
export function threadFailure(
  snapshot: ThreadSnapshot,
  root: boolean,
): "not-found" | "unavailable" | undefined {
  if (root && snapshot.status === "error") return "unavailable";
  if (snapshot.targetStatus === "unavailable") return "not-found";
  if (snapshot.targetStatus === "error") return "unavailable";
  return undefined;
}

/** Session-owned evidence. Finite page cursors NEVER come from the live/local display union. */
export function createThreadView({
  channelId,
  messageId,
  relayAuthor,
  signingAuthority,
  agentOwner,
  reader: sourceReader,
  targetReader: sourceTargetReader = sourceReader,
  admitTarget,
  seed,
  resume,
  local,
  canAccess,
  canRefresh = canAccess,
  visible,
  notify,
  exact = false,
  subthread = false,
  priority = "foreground",
  admit = (events) => events,
  clock = new MessageClock(),
  dropped: openedDropped = false,
  now = Date.now,
  recover,
}: {
  channelId: string;
  messageId: string;
  relayAuthor: string;
  /** Explicit NIP-11 self; only it may attribute messages to others. */
  signingAuthority?: string | undefined;
  agentOwner?: ((pubkey: string) => string | undefined) | undefined;
  reader: RelayReader;
  targetReader?: RelayReader;
  admitTarget?: (events: readonly RelayEvent[]) => readonly RelayEvent[];
  seed: RelayEvent | undefined;
  /** Ignored by exact views and by a view of a reply. */
  resume?: ThreadResume | undefined;
  local: LocalEvents | undefined;
  canAccess(): boolean;
  /** Cached membership can display saved rows but cannot authorize a network retry. */
  canRefresh?(): boolean;
  visible(events: readonly RelayEvent[]): readonly RelayEvent[];
  notify(listener: () => void): void;
  exact?: boolean;
  /** Project the branch anchored by the opening message. */
  subthread?: boolean;
  /** Admission for every read this view makes. A passive reader, one that
   * only decorates a link, takes `background` so an opened or previewed
   * conversation's reads start ahead of it. */
  priority?: Priority | undefined;
  /** The session's send clock; rendered replies raise its channel watermark. */
  clock?: MessageClock;
  /** Exact finite reads enter session reconciliation only after a complete fold. */
  admit?:
    | ((events: readonly RelayEvent[]) => readonly RelayEvent[])
    | undefined;
  /** Opened while the stream was down, or before it was up: the first read
   * is the snapshot its establishment refresh must reach. */
  dropped?: boolean;
  /** The store's clock: a thread resumes with no read on the same age rule. */
  now?: (() => number) | undefined;
  /** Set for a view a person reads, not one that decorates a link. A transient
   * read failure keeps the state its read began in, for session recovery to
   * retry, and older pages are read for a loaded reply's missing parent.
   * Called when `recovery()` may have changed. */
  recover?: (() => void) | undefined;
}) {
  // Only a view with `recover` is a session recovery source. The existing
  // selection/page controllers still own cancellation and stale-result fencing.
  const retrying = (source: RelayReader): RelayReader => ({
    read: (filters, settings) =>
      retryRead(
        (signal) => source.read(filters, { priority, ...settings, signal }),
        settings?.signal ?? new AbortController().signal,
        (error) => canRefresh() && isRetryableRead(error),
      ),
  });
  const reader = retrying(sourceReader);
  const targetReader = retrying(sourceTargetReader);
  const acceptTarget = admitTarget ?? admit;
  // Only a view created exact reads through a reader that returns rows
  // unadmitted; a retarget makes a view exact but keeps its reader.
  const unadmitted = exact;
  const subthreadId = subthread ? messageId : undefined;
  let branchOpening: Parameters<ThreadView["refresh"]>[0];
  let disposed = false;
  let rootId: string | undefined;
  let rootUnavailable = false;
  let targetStatus: ThreadSnapshot["targetStatus"] = exact
    ? "loading"
    : undefined;
  let remote: readonly RelayEvent[] = [];
  let remoteIds = new Set<string>();
  let staged: readonly RelayEvent[] = [];
  let selectionStaged: readonly RelayEvent[] = [];
  let selectionController: AbortController | undefined;
  let selectionRevision = 0;
  // A selected reply stays in the rows after a retarget back to the root.
  let selectedReply = false;
  // Strict reads require transport-supplied binding authority. Missing scope is
  // a configuration error, not evidence of an old relay that permits fallback.
  let mode: "probe" | "older" | "legacy" = canonicalChannel.test(channelId)
    ? "probe"
    : "legacy";
  /** Where each page of the traversal starts (undefined: its origin), plus
   * the continuation past the last page read. Only pages [lo, pages) are
   * resident: the rest were evicted, and are read again from their start. */
  let starts: (ThreadCursor | undefined)[] = [];
  let lo = 0;
  let pages = 0;
  /** The last page read proved more history past it. */
  let hasMore = false;
  /** A size bound evicted a page: the window is full, whatever its page count. */
  let filled = false;
  let pinned: string | undefined;
  /** Evicted events, so a live deletion of one is kept for when it is read again. */
  const evicted = new Set<string>();
  const isReply = (event: RelayEvent) =>
    !AUX.has(event.kind) &&
    event.id !== rootId &&
    inChannel(event, channelId) &&
    threadReference(event)?.rootId === rootId;
  /** Replies a strict refresh must reach from its newest page. The selected
   * target and the pinned reply are retained beyond traversal by design. */
  const unverified = () =>
    new Set(
      remote
        .filter(
          (event) =>
            isReply(event) &&
            event.id !== subthreadId &&
            event.id !== pinned &&
            !(exact && event.id === messageId),
        )
        .map((event) => event.id),
    );
  /** Traversal order, as each relay pages: strict windows newest first with
   * ids ascending within a second, legacy oldest first. */
  const order = (a: ThreadCursor, b: ThreadCursor) =>
    mode === "older"
      ? b.created_at - a.created_at || a.id.localeCompare(b.id)
      : compare(a, b);
  /** A row past an evicted page boundary. Each page holds the rows after its
   * start, up to and including the next page's start. */
  const outside = (event: RelayEvent) => {
    const first = lo > 0 ? starts[lo] : undefined;
    const last = pages < starts.length - 1 ? starts[pages] : undefined;
    return (
      (!!first && order(event, first) <= 0) ||
      (!!last && order(event, last) > 0)
    );
  };
  const canContinue = () => hasMore || pages < starts.length - 1;
  const paging = () => ({
    canLoadMore: canContinue(),
    canLoadBack: lo > 0,
    limited: canContinue() && (pages - lo >= MAX_PAGES || filled),
  });
  function rewind() {
    filled = false;
    reading = undefined;
    starts = [];
    lo = 0;
    pages = 0;
    hasMore = false;
  }
  /** Drop replies outside the window with their overlays. Deletions are kept
   * for the view's lifetime, so an evicted reply read again can never show
   * as undeleted; so are the exact target and every resident reply's
   * ancestors, so eviction never detaches a reply from its parent. */
  function evict(gone: (event: RelayEvent) => boolean = outside) {
    const byId = new Map(remote.map((event) => [event.id, event]));
    const kept = new Set<string>();
    const hold = (id: string | undefined) => {
      for (
        let event = id ? byId.get(id) : undefined;
        event && !kept.has(event.id);
        event = byId.get(threadReference(event)?.parentId ?? "")
      )
        kept.add(event.id);
    };
    for (const event of remote)
      if (isReply(event) && !gone(event)) hold(event.id);
    if (exact) hold(messageId);
    hold(pinned);
    const dropped = new Set(
      remote
        .filter((event) => isReply(event) && !kept.has(event.id))
        .map((event) => event.id),
    );
    if (!dropped.size) return;
    for (let more = true; more; ) {
      more = false;
      for (const event of remote) {
        if (
          !AUX.has(event.kind) ||
          event.kind === 5 ||
          event.kind === 9005 ||
          dropped.has(event.id)
        )
          continue;
        const targets = event.tags.filter(([name]) => name === "e");
        if (
          targets.length &&
          targets.every(([, id]) => dropped.has(id ?? ""))
        ) {
          dropped.add(event.id);
          more = true;
        }
      }
    }
    for (const id of dropped) evicted.add(id);
    setRemote(remote.filter((event) => !dropped.has(event.id)));
    if (held) held = new Set([...held].filter((id) => !dropped.has(id)));
  }
  const over = () =>
    remote.length > MAX_EVENTS || listByteSize(remote) > MAX_BYTES;
  /** Live replies grew the only resident page: end a page at its middle
   * reply, so one half can be evicted and read again from there. */
  function split() {
    const rows = remote
      .filter((event) => isReply(event) && !outside(event))
      .sort(order);
    const cut = rows[Math.ceil(rows.length / 2) - 1];
    if (rows.length < 2 || !cut) return false;
    starts.splice(pages, 0, { created_at: cut.created_at, id: cut.id });
    pages++;
    if (starts.length <= pages) starts.length = pages + 1;
    return true;
  }
  /** Evict whole pages from one end until the window fits. The last page
   * always stays, so one oversized page is held rather than lost; live
   * growth may divide it. */
  function shrink(from: "start" | "end", live = false) {
    let moved = false;
    while (
      pages - lo > MAX_PAGES ||
      (over() && (pages - lo > 1 || (live && pages - lo === 1 && split())))
    ) {
      if (from === "start") lo++;
      else pages--;
      evict();
      moved = true;
    }
    filled ||= moved;
    return moved;
  }
  const oldest = () => (mode === "older" ? "end" : "start");
  /** The end of the window the last page read landed at. */
  let reading: "start" | "end" | undefined;
  /** Live growth evicts the oldest end, away from where replies arrive. A
   * window off that end evicts away from the page last read instead. */
  const away = () => {
    if (!reading || (mode === "older" ? lo === 0 : !canContinue()))
      return oldest();
    return reading === "end" ? "start" : "end";
  };
  /** The replies held when the stream dropped, or read while it was down,
   * until the refresh after it is back completes. The re-established stream
   * replays its last minutes before that refresh; those replies are newer
   * than any gap, not overlap with it. */
  let held: Set<string> | undefined;
  /** The stream is down: a completed refresh keeps `held`, taking one from
   * its replies if the view has none. Only its establishment refresh clears it. */
  let dropped = openedDropped;
  /** The view was ready, with no read running, when the stream dropped, and
   * its replies came from a refresh started at most `RESUME_READ_AGE` before:
   * they reached the live stream then. Cleared by any establishment. */
  let liveAtDrop = false;
  /** When the refresh whose replies the view holds started. */
  let readAt = -Infinity;
  let controller: AbortController | undefined;
  /** Replies that arrived outside the window while a read ran: the window it
   * lands on may hold them. */
  let arrivals: RelayEvent[] = [];
  /** A refresh requested while a read runs; the stream's return carries over. */
  let again: false | "refresh" | "established" = false;
  /** An older page asked for while a read runs or a quiet failure waits, read
   * after it: `true`, or the frontier to read to. */
  let older: (() => number) | boolean = false;
  /** A window move requested while a read runs or a quiet failure waits. */
  let queued: false | "back" | "latest" = false;
  /** The read that failed transiently, which session recovery retries. */
  let failed: "refresh" | "older" | undefined;
  /** The read running is one for a missing parent, or `null` once the relay
   * rejected one: no other follows. See `advance`. */
  let seek: AbortController | null | undefined;
  /** Resumed rows shown beside the evidence until the first refresh settles.
   * That refresh reads as a fresh view would, in the background. */
  let shown: ThreadResume | undefined;
  let snapshot: ThreadSnapshot = Object.freeze({
    status: "idle",
    root: undefined,
    replies: Object.freeze([]),
    error: undefined,
    canLoadMore: false,
    canLoadBack: false,
    limited: false,
  });
  const listeners = new Set<() => void>();
  // The last fold's local and profile inputs: its operations and the agent
  // owners it looked up.
  let localInputs: ReturnType<LocalEvents["snapshot"]> = [];
  let owners = new Map<string, string | undefined>();
  // Resumed rows re-verified against a changed owner, kept stable per verdict.
  const reattributed = new WeakMap<ChannelMessage, ChannelMessage>();
  function related<T extends EventData>(
    events: readonly T[],
    selectedId = exact ? messageId : undefined,
  ): T[] {
    if (!rootId && !selectedId) return [];
    const rows = events.filter(
      (event) =>
        !AUX.has(event.kind) &&
        event.kind !== 39007 &&
        inChannel(event, channelId) &&
        (event.id === rootId ||
          (!!selectedId && event.id === selectedId) ||
          (!!rootId && threadReference(event)?.rootId === rootId)),
    );
    const ids = new Set([
      ...(selectedId ? [selectedId] : []),
      ...[...remote, ...staged, ...selectionStaged, ...arrivals, ...rows].map(
        (event) => event.id,
      ),
    ]);
    const result = new Map(rows.map((event) => [event.id, event]));
    // Aux closure includes deletion of an auxiliary, not just direct row overlays.
    for (let hop = 0; hop < 2; hop++) {
      for (const event of events) {
        if (!AUX.has(event.kind) || result.has(event.id)) continue;
        const deletion = event.kind === 5 || event.kind === 9005;
        if (
          event.tags.some(
            ([name, value]) =>
              name === "e" &&
              (ids.has(value ?? "") || (deletion && evicted.has(value ?? ""))),
          )
        ) {
          result.set(event.id, event);
          ids.add(event.id);
        }
      }
    }
    return [...result.values()];
  }
  function union(...batches: readonly (readonly RelayEvent[])[]) {
    const events = new Map<string, RelayEvent>();
    const summaries = new Map<string, RelayEvent>();
    for (const event of batches.flat()) {
      if (event.kind === 39005) {
        const target = event.tags.find(([name]) => name === "e")?.[1];
        if (!target || event.pubkey !== relayAuthor) continue;
        const previous = summaries.get(target);
        const latest = newer(previous, event);
        if (latest !== event) continue;
        if (previous) events.delete(previous.id);
        summaries.set(target, event);
      }
      events.set(event.id, event);
    }
    // Match the fold before budgeting; messages and tombstones remain evidence.
    return [...events.values()];
  }
  /** A fold that changed nothing keeps the snapshot and notifies no one. */
  function emit(next: ThreadSnapshot) {
    // A parent retained but not shown, as a deleted one is, is not coming.
    const known = new Set(next.replies.map((row) => row.id));
    const seeking =
      seek !== null &&
      (next.direction
        ? next.direction === "older" && next.canLoadMore && !next.limited
        : next.status === "idle" || next.status === "loading") &&
      next.replies.some(
        (row) =>
          row.replyParentId &&
          row.replyParentId !== rootId &&
          !known.has(row.replyParentId) &&
          !remoteIds.has(row.replyParentId),
      );
    next = {
      ...next,
      seeking: seeking || undefined,
      recovering: failed ? true : undefined,
    };
    const keys = Object.keys(next) as (keyof ThreadSnapshot)[];
    if (keys.every((key) => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function publishStatus(patch: Partial<ThreadSnapshot>) {
    if (disposed) return;
    emit({
      ...snapshot,
      ...patch,
      ...(exact
        ? {
            target: targetStatus === "ready" ? snapshot.target : undefined,
            targetStatus,
          }
        : {}),
    });
  }
  /** This thread's local operations; others never reach its fold. */
  function localOperations() {
    const operations = (canAccess() ? (local?.snapshot() ?? []) : []).filter(
      // Failed reply intent stays visible for same-event retry, just like channel
      // messages; failed edits/reactions must not change the rendered content.
      (item) => item.delivery !== "failed" || isThreadContent(item.event),
    );
    const events = new Set(related(operations.map((item) => item.event)));
    return operations.filter((item) => events.has(item.event));
  }
  function publish(patch: Partial<ThreadSnapshot> = {}) {
    if (disposed) return;
    const operations = localOperations();
    localInputs = operations;
    const inputs = new Map(
      remote.map((event) => [event.id, event as EventData]),
    );
    for (const item of operations) inputs.set(item.event.id, item.event);
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const looked = new Map<string, string | undefined>();
    owners = looked;
    // A resumed row was attributed by the owner its agent had when the thread
    // closed. Verify it again as the fold would, against the owner now.
    const attributed = (row: ChannelMessage) => {
      const relayed = row.relayedFrom;
      if (!relayed) return row;
      const owner = agentOwner?.(relayed.agent);
      looked.set(relayed.agent, owner);
      const verified = !row.signerId && owner === row.authorId;
      if (verified === relayed.verified) return row;
      const cached = reattributed.get(row);
      if (cached?.relayedFrom?.verified === verified) return cached;
      const next = Object.freeze({
        ...row,
        relayedFrom: Object.freeze({ ...relayed, verified }),
      });
      reattributed.set(row, next);
      return next;
    };
    const sourceRows = shareMessageRows(
      [
        ...(snapshot.root ? [snapshot.root] : []),
        ...snapshot.replies,
        ...(snapshot.pinnedTarget ? [snapshot.pinnedTarget] : []),
      ],
      foldMessages(
        channelId,
        relayAuthor,
        rootUnavailable && !exact ? [] : [...inputs.values()],
        {
          includeReplies: true,
          signingAuthority,
          agentOwner:
            agentOwner &&
            ((pubkey) => {
              const owner = agentOwner(pubkey);
              looked.set(pubkey, owner);
              return owner;
            }),
        },
      ).map((row) => {
        const item = deliveries.get(row.id);
        return item
          ? Object.freeze({
              ...row,
              delivery: item.delivery,
              deliveryError: item.error,
            })
          : row;
      }),
    );
    const displayedRoot = subthreadId ?? rootId;
    let rows = sourceRows;
    if (subthreadId) {
      if (
        rootUnavailable ||
        !sourceRows.some((row) => row.id === rootId) ||
        !sourceRows.some((row) => row.id === subthreadId)
      )
        rows = [];
      else if (subthreadId !== rootId)
        rows = subthreadMessages(
          sourceRows,
          subthreadId,
          targetStatus === "ready" ? messageId : undefined,
        );
    }
    const target =
      targetStatus === "ready"
        ? rows.find((row) => row.id === messageId)
        : undefined;
    if (targetStatus === "ready" && !target) targetStatus = "unavailable";
    const readable = rows.filter(
      (row) => !exact || row.id !== messageId || targetStatus === "ready",
    );
    const pinnedTarget = pinned
      ? readable.find((row) => row.id === pinned)
      : undefined;
    const byId = new Map(remote.map((event) => [event.id, event]));
    const inWindow = new Set<string>();
    const holdWindow = (id: string | undefined) => {
      for (
        let event = id ? byId.get(id) : undefined;
        event && !inWindow.has(event.id);
        event = byId.get(threadReference(event)?.parentId ?? "")
      )
        inWindow.add(event.id);
    };
    for (const event of remote)
      if (isReply(event) && !outside(event)) holdWindow(event.id);
    if (exact) holdWindow(messageId);
    const windowReplies = readable.filter(
      (row) =>
        row.id !== displayedRoot &&
        (!rootUnavailable || row.id === messageId) &&
        (!byId.has(row.id) || inWindow.has(row.id)),
    );
    const cutSecond =
      mode === "older" && lo > 0 ? starts[lo]?.created_at : undefined;
    const cutKeep = new Set<string>();
    if (
      cutSecond !== undefined &&
      windowReplies.some((row) => row.createdAt !== cutSecond)
    ) {
      const rowById = new Map(windowReplies.map((row) => [row.id, row]));
      const keepRow = (id: string | undefined) => {
        for (
          let row = id ? rowById.get(id) : undefined;
          row && !cutKeep.has(row.id);
          row = row.replyParentId ? rowById.get(row.replyParentId) : undefined
        )
          cutKeep.add(row.id);
      };
      for (const row of windowReplies)
        if (
          row.createdAt !== cutSecond ||
          (exact && row.id === messageId) ||
          deliveries.has(row.id)
        )
          keepRow(row.id);
    }
    const nextReplies = (
      cutKeep.size
        ? windowReplies.filter((row) => cutKeep.has(row.id))
        : windowReplies
    ).sort(compareMessages);
    for (const row of nextReplies)
      clock.observe(channelId, row.createdAtMs ?? row.createdAt * 1000);
    let nextRoot = !rootUnavailable
      ? readable.find((row) => row.id === displayedRoot)
      : undefined;
    if (shown && !rootUnavailable) {
      // Evidence wins. A resumed row fills in only an event not read yet, and
      // never one a retained deletion names, valid or not: the refresh decides.
      const read = deletionTargets(inputs.values());
      for (const event of inputs.values()) read.add(event.id);
      nextReplies.push(
        ...shown.replies.filter((row) => !read.has(row.id)).map(attributed),
      );
      nextReplies.sort(compareMessages);
      if (!read.has(shown.root.id)) nextRoot ??= attributed(shown.root);
    }
    const replies =
      snapshot.replies.length === nextReplies.length &&
      snapshot.replies.every((row, index) => row === nextReplies[index])
        ? snapshot.replies
        : Object.freeze(nextReplies);
    emit({
      ...snapshot,
      ...patch,
      root: nextRoot,
      replies,
      pinnedTarget,
      resumed: shown ? true : undefined,
      ...(exact ? { target, targetStatus } : {}),
    });
  }
  function setRemote(events: readonly RelayEvent[]) {
    remote = events;
    remoteIds = new Set(events.map((event) => event.id));
  }
  function receive(events: readonly RelayEvent[]) {
    if (disposed || !canAccess() || (!rootId && !exact)) return;
    const fresh = events.filter((event) => !remoteIds.has(event.id));
    if (!fresh.length) return;
    // A reply past an evicted page would show beyond the gap; it returns
    // with its page, unless a read moving the window lands over it first.
    const found = related(fresh);
    const incoming = found.filter(
      (event) => !isReply(event) || !outside(event),
    );
    const heldOff = found.filter((event) => isReply(event) && outside(event));
    for (const event of heldOff) evicted.add(event.id);
    if (controller && heldOff.length) arrivals.push(...heldOff);
    if (!incoming.length) return;
    setRemote(union(remote, incoming));
    // A read in progress fits the window when it lands.
    publish(!controller && shrink(away(), true) ? paging() : {});
    advance();
  }
  /** Reads the next older page once no read runs or waits on recovery: one
   * asked for, else, in the background, one that may hold the parent of a
   * reply shown without it. Each page that lands advances again. */
  function advance() {
    if (disposed || controller || failed) return;
    if (queued) {
      const kind = queued;
      queued = false;
      void run(kind);
    } else if (older) {
      const through = older === true ? undefined : older;
      older = false;
      void run("more", false, through);
    } else if (
      recover &&
      // A resumed view has no page of its own to read on from yet.
      pages > 0 &&
      snapshot.status === "ready" &&
      snapshot.seeking
    )
      void run("more", false, undefined, true);
  }
  if (
    !subthreadId &&
    seed &&
    canAccess() &&
    isThreadContent(seed) &&
    inChannel(seed, channelId)
  ) {
    rootId = threadReference(seed)?.rootId ?? seed.id;
    if (seed.id === rootId) {
      remote = [seed];
      remoteIds.add(seed.id);
    }
    publish();
  }
  if (
    resume &&
    !exact &&
    canAccess() &&
    resume.root.id === messageId &&
    (!rootId || rootId === messageId)
  ) {
    rootId = messageId;
    shown = resume;
    publish({
      status: "ready",
      direction: resume.direction,
      canLoadMore: resume.canLoadMore,
      limited: resume.limited,
    });
  }
  function purge(clear = false) {
    // A purged view no longer holds what the stream delivered before the drop.
    liveAtDrop = false;
    readAt = -Infinity;
    controller?.abort();
    selectionController?.abort();
    selectionController = undefined;
    selectionStaged = [];
    controller = undefined;
    arrivals = [];
    again = false;
    older = false;
    queued = false;
    failed = undefined;
    staged = [];
    shown = undefined;
    if (exact) targetStatus = "loading";
    if (clear || !canAccess()) {
      remote = [];
      staged = [];
      evicted.clear();
      pinned = undefined;
      rootId = undefined;
      rewind();
      held = undefined;
    } else remote = visible(remote);
    remoteIds = new Set(remote.map((event) => event.id));
    publish({
      status: "idle",
      canLoadMore: false,
      canLoadBack: false,
      limited: false,
      error: canAccess()
        ? "Thread read interrupted. Refresh to continue."
        : "This channel is no longer available.",
      readKind: undefined,
    });
    recover?.();
  }
  // Exact selection shares the same bounded evidence and live reconciliation
  // as initial navigation, but never uses the selected row as a page cursor.
  async function readTarget(
    id: string,
    owned: AbortController,
    expectedRoot?: string,
    selecting = false,
  ): Promise<ThreadRetarget> {
    if (!/^[0-9a-f]{64}$/.test(id)) return "unavailable";
    const active = () =>
      !disposed &&
      !owned.signal.aborted &&
      (selecting ? selectionController : controller) === owned;
    let pending: readonly RelayEvent[] = [];
    const stage = (events: readonly RelayEvent[]) => {
      pending = events;
      if (selecting) selectionStaged = events;
      else staged = events;
    };
    const target = targetReader.read(
      [{ ids: [id], "#h": [channelId], limit: 1 }],
      { signal: owned.signal },
    );
    // The overlay read overlaps the target read; its rows are staged only
    // after the target is.
    const overlaysRead = targetReader.read(
      [{ kinds: [5, 7, 9005, 40003, 39005], "#e": [id], limit: 500 }],
      { signal: owned.signal },
    );
    overlaysRead.catch(() => undefined);
    const response = await target;
    if (!active()) return "cancelled";
    // The reader verifies the wire response; this pure visibility check does
    // not reconcile the bare candidate into this or another published view.
    // Only the complete target/overlay fold enters shared admission below.
    const event = visible(response).find(
      (event) =>
        event.id === id &&
        isThreadContent(event) &&
        inChannel(event, channelId),
    );
    if (!active()) return "cancelled";
    if (!event) return "unavailable";
    const resolvedRoot = threadReference(event)?.rootId ?? event.id;
    if (expectedRoot && resolvedRoot !== expectedRoot) return "different";
    // Staging makes live overlay deletions resolvable without exposing an
    // incomplete selected fold. Existing displayed content remains untouched.
    stage([event]);
    if (subthreadId && subthreadId !== resolvedRoot && id !== subthreadId) {
      const branch = await readSubthread(
        [event],
        { channel: channelId, root: resolvedRoot, anchor: subthreadId },
        [9, 40002, 40008],
        async (filters) =>
          visible(
            await targetReader.read(filters, {
              signal: owned.signal,
            }),
          ),
        new Map(remote.map((row) => [row.id, row])),
      );
      if (!active()) return "cancelled";
      if (!branch.events.length) {
        stage([]);
        return "different";
      }
    }
    const overlays = await overlaysRead;
    if (!active()) return "cancelled";
    stage(union(pending, related(overlays, id)));
    const ids = union(remote, pending)
      .filter(
        (event) =>
          AUX.has(event.kind) &&
          event.tags.some(([name, value]) => name === "e" && value === id),
      )
      .map((event) => event.id);
    if (ids.length) {
      const tombstones = await targetReader.read(
        [{ kinds: [5, 9005], "#e": ids, limit: 500 }],
        { signal: owned.signal },
      );
      if (!active()) return "cancelled";
      stage(union(pending, related(tombstones, id)));
    }
    // Live deletions received while reads were held are retained only by this
    // reader; admit them with the fold so every reader withdraws the overlay.
    const staging = new Set(pending.map((event) => event.id));
    const accepted = acceptTarget(
      union(
        pending,
        remote.filter(
          (event) =>
            (event.kind === 5 || event.kind === 9005) &&
            event.tags.some(
              ([name, value]) => name === "e" && staging.has(value ?? ""),
            ),
        ),
      ),
    );
    if (!active()) return "cancelled";
    if (!accepted.some((event) => event.id === id)) {
      stage([]);
      return "unavailable";
    }
    // Rejected first-open evidence must never latch a root that later live
    // traffic could populate. Resolve identity only after final admission.
    if (!selecting) rootId = resolvedRoot;
    const combined = union(remote, related(accepted, id));
    setRemote(combined);
    stage([]);
    if (
      (selecting || subthreadId) &&
      !foldMessages(channelId, relayAuthor, combined, {
        includeReplies: true,
        signingAuthority,
        agentOwner,
      }).some((row) => row.id === id)
    ) {
      // Keep real tombstones, but do not replace the selected target with a
      // message whose complete fold is unavailable.
      publish();
      return "unavailable";
    }
    return "selected";
  }
  async function retarget(
    id: string,
    signal: AbortSignal,
  ): Promise<ThreadRetarget> {
    if (disposed || signal.aborted || !canAccess()) return "cancelled";
    if (!/^[0-9a-f]{64}$/.test(id)) return "unavailable";
    // A route hint is never evidence that two messages belong to one thread.
    if (!rootId || !snapshot.root) return "different";
    selectionController?.abort();
    selectionStaged = [];
    const owned = new AbortController();
    const cancel = () => owned.abort();
    signal.addEventListener("abort", cancel, { once: true });
    selectionController = owned;
    try {
      const result = await readTarget(id, owned, rootId, true);
      if (disposed || owned.signal.aborted || selectionController !== owned)
        return "cancelled";
      if (result !== "selected") return result;
      selectionRevision++;
      messageId = id;
      exact = true;
      if (id !== rootId) selectedReply = true;
      targetStatus = "ready";
      publish(
        controller
          ? {}
          : { status: "ready", error: undefined, readKind: undefined },
      );
      return snapshot.targetStatus === "ready" ? "selected" : "unavailable";
    } catch {
      return disposed || owned.signal.aborted || selectionController !== owned
        ? "cancelled"
        : "error";
    } finally {
      // Stops a read started alongside another that this ended without.
      owned.abort();
      signal.removeEventListener("abort", cancel);
      if (selectionController === owned) {
        selectionStaged = [];
        selectionController = undefined;
      }
    }
  }

  /** Demand for an older page. It waits out a quiet failure, whose retry is
   * session recovery's. */
  async function more(through?: () => number) {
    if (!failed) return run("more", false, through);
    if (queued !== "latest") older = through ?? (older || true);
    // The wait shows as the read it is for.
    publishStatus({ status: "loading", readKind: "older" });
  }
  /** Demand to move the window back toward its first page. */
  async function page(kind: "back" | "latest") {
    if (!failed) return run(kind);
    if (queued !== "latest") {
      queued = kind;
      older = false;
    }
    publishStatus({
      status: "loading",
      readKind: kind === "back" ? "back" : "refresh",
    });
  }
  /** A refresh re-reads the resident pages; `more` continues the traversal;
   * `back` reads the evicted page before the window again; `latest` reads
   * the first page, replacing a window that had moved off it. */
  async function run(
    kind: "refresh" | "more" | "back" | "latest",
    established = false,
    through?: () => number,
    /** For a missing parent, not a person: see `advance`. */
    sought = false,
  ) {
    if (disposed) return;
    const replace = kind === "refresh";
    // A read someone asked for takes the place of one for a missing parent.
    if (controller && controller === seek) controller.abort();
    else if (controller) {
      if (established) again = "established";
      else if (replace) again ||= "refresh";
      else if (kind === "more") {
        // Reopening at the newest page outranks a page read asked for after it.
        if (queued !== "latest") older = through ?? (older || true);
      } else if (queued !== "latest") {
        queued = kind;
        older = false;
      }
      return;
    }
    if (!canAccess()) {
      purge();
      return;
    }
    if (
      (kind === "more" && !snapshot.canLoadMore) ||
      (kind !== "refresh" && kind !== "more" && !lo) ||
      (sought && snapshot.limited)
    )
      return;
    // A retry stays as quiet as the failure it follows.
    const background =
      established || sought || (replace && (!!shown || !!failed));
    failed = undefined;
    const asked =
      kind === "more" ? "older" : kind === "back" ? "back" : "refresh";
    const owned = new AbortController();
    controller = owned;
    if (seek !== null) seek = sought ? owned : undefined;
    // A read for a missing parent yields to the reads a person waits on.
    const yielding = sought ? { priority: "background" as const } : {};
    const startedAt = now();
    // A read after the drop can fail or replace the rows the stream kept live,
    // so only an untouched view may skip its establishment refresh.
    liveAtDrop = false;
    // Cleared as this refresh starts, not when the stream came back: a refresh
    // it supersedes still completes against the replies held across the drop.
    if (established) dropped = false;
    const active = () =>
      !disposed && !owned.signal.aborted && controller === owned;
    // Pages [first, first + count) are read from their recorded starts.
    const first = { refresh: lo, more: pages, back: lo - 1, latest: 0 }[kind];
    const count = replace ? Math.max(1, pages - lo) : 1;
    // A page read again ends where the window begins, unless a reply was
    // since backdated into it.
    const boundary = kind === "back" ? starts[lo] : undefined;
    let nextCursor = starts[first];
    let nextPages = first;
    let fetched: readonly RelayEvent[] = [];
    let branchSelection: { revision: number; id: string } | undefined;
    // Repair retains already-verified presentation; only a new/unavailable
    // selection waits for its initial fold. Never unmount a reader on reconnect.
    if (exact && replace && targetStatus !== "ready") targetStatus = "loading";
    // A stream establishment (a reconnect, or a minute renewal) repairs a ready
    // view in the background: it stays ready unless the repair changes it.
    if (!background || snapshot.status !== "ready")
      publishStatus({
        status: "loading",
        error: undefined,
        // A quiet retry leaves a page asked for behind it showing as that
        // page.
        readKind: kind === "refresh" && background && older ? "older" : asked,
      });
    try {
      if (exact && replace) {
        const revision = selectionRevision;
        const selectedId = messageId;
        const anchor = subthreadId ?? selectedId;
        const anchorResult = await readTarget(
          anchor,
          owned,
          branchOpening?.sourceThreadId,
        );
        if (!active()) return;
        if (anchorResult !== "selected" && revision === selectionRevision) {
          targetStatus = "unavailable";
          publish({ status: "ready", canLoadMore: false });
          return;
        }
        if (revision === selectionRevision) {
          // Prove the selection after the source read so deep branches can use
          // their loaded ancestry without spending bounded exact queries.
          if (subthreadId) branchSelection = { revision, id: selectedId };
          else {
            targetStatus = "ready";
            publish();
            if (snapshot.targetStatus !== "ready") {
              publish({ status: "ready", canLoadMore: false });
              return;
            }
          }
        }
      }
      if (!rootId) {
        const selected = await reader.read(
          [{ ids: [messageId], "#h": [channelId], limit: 1 }],
          { signal: owned.signal },
        );
        if (!active()) return;
        const event = selected.find(
          (event) =>
            event.id === messageId &&
            isThreadContent(event) &&
            inChannel(event, channelId),
        );
        if (!event) throw new Error("The selected message is unavailable.");
        rootId = threadReference(event)?.rootId ?? event.id;
      }
      const rootFilter: ReadFilter = {
        ids: [rootId],
        "#h": [channelId],
        limit: 1,
      };
      const filter: ReadFilter = {
        kinds: [9, 40002, 40008],
        "#h": [channelId],
        "#e": [rootId],
        depth_limit: 100,
        limit: PAGE_SIZE,
        include_aux: true,
      };
      const speculativeBack = kind === "back";
      const pageReader = speculativeBack ? targetReader : reader;
      const rawBackPages: (readonly RelayEvent[])[] = [];
      const backStarts: (ThreadCursor | undefined)[] = [];
      const windowRead = (signal: AbortSignal) =>
        pageReader.read(
          [
            {
              ...filter,
              kinds: STRICT_WINDOW_KINDS,
              limit: nextPages === 0 ? INITIAL_WINDOW_SIZE : PAGE_SIZE,
              thread_window: true,
              ...(nextCursor
                ? { until: nextCursor.created_at, before_id: nextCursor.id }
                : {}),
            },
          ],
          { signal, ...yielding },
        );
      let firstWindow: ReturnType<typeof windowRead> | undefined;
      let root: readonly RelayEvent[] = [];
      if (mode !== "legacy") {
        // Strict requests cannot batch an ID lookup with a window. Admit the
        // verified root first so channel-less root aux has visibility evidence:
        // the first window's rows are read only after it.
        // Revalidate once per run, not once per page of a retained-range repair.
        const rootRead = pageReader.read([rootFilter], {
          signal: owned.signal,
          ...yielding,
        });
        // An admitting reader would drop root aux from a window answered
        // before the root; only an unadmitting one overlaps the window.
        if (unadmitted) {
          firstWindow = windowRead(owned.signal);
          firstWindow.catch(() => undefined);
        }
        const rootResponse = await rootRead;
        if (!active()) return;
        root = speculativeBack ? visible(rootResponse) : admit(rootResponse);
        if (!active()) return;
        if (
          !root.some(
            (event) =>
              event.id === rootId &&
              isThreadContent(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          rootUnavailable = true;
          rewind();
          publish({ canLoadMore: false, canLoadBack: false });
          throw new Error("The original thread message is unavailable.");
        }
        if (!speculativeBack) setRemote(union(remote, related(root)));
      }
      // A strict refresh at the window's newest end re-reads from it. Live
      // replay covers minutes, not a long disconnect, so keep paging until a
      // reply kept across the drop is reached.
      const kept = replace ? (held ?? unverified()) : new Set<string>();
      let reached = !kept.size;
      let more = false;
      let oldestRead = Infinity;
      for (
        let page = 0;
        page < count ||
        (mode === "older" && !reached && page < MAX_PAGES) ||
        (through !== undefined &&
          oldestRead > through() &&
          nextPages - lo < MAX_PAGES) ||
        (!!boundary &&
          more &&
          !!nextCursor &&
          order(nextCursor, boundary) < 0 &&
          page < MAX_PAGES);
        page++
      ) {
        let response: readonly RelayEvent[];
        let bounds: ReturnType<typeof threadBounds> | undefined;
        if (mode !== "legacy") {
          try {
            const read = firstWindow ?? windowRead(owned.signal);
            firstWindow = undefined;
            const page = await read;
            if (!active()) return;
            const bound = page.find((event) => event.kind === 39007);
            if (!bound) throw new MissingThreadBounds();
            bounds = threadBounds(bound); // Reader already verified signer and full request binding.
            mode = "older";
            response = [
              ...root,
              ...page.filter((event) => event.kind !== 39007),
            ];
          } catch (error) {
            if (!active()) return;
            if (
              !(error instanceof MissingThreadBounds) ||
              !error.legacyRows ||
              mode !== "probe"
            )
              throw error;
            // A 200 without bounds is not support. Probe rows never entered the
            // session; retry from scratch without a reverse cursor or opt-in.
            mode = "legacy";
            nextCursor = undefined;
            nextPages = 0;
            response = await pageReader.read([rootFilter, filter], {
              signal: owned.signal,
            });
          }
        } else {
          response = await pageReader.read(
            [
              rootFilter,
              {
                ...filter,
                ...(nextCursor
                  ? {
                      thread_cursor: nextCursor.created_at,
                      thread_cursor_id: nextCursor.id,
                    }
                  : {}),
              },
            ],
            { signal: owned.signal },
          );
        }
        if (!active()) return;
        const events = speculativeBack ? visible(response) : admit(response);
        if (!active()) return;
        if (
          !events.some(
            (event) =>
              event.id === rootId &&
              isThreadContent(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          // Hide unavailable history without throwing away known tombstones.
          rootUnavailable = true;
          rewind();
          publish({ canLoadMore: false, canLoadBack: false });
          throw new Error("The original thread message is unavailable.");
        }
        // Count traversal rows before presentation filtering. The bridge may return
        // other content kinds, and appended auxiliaries do not consume its page limit.
        const replies = events.filter(isReply).sort(compare);
        reached ||= replies.some((event) => kept.has(event.id));
        for (const event of replies)
          oldestRead = Math.min(oldestRead, event.created_at);
        if (
          !bounds &&
          replies.some((event) => nextCursor && compare(event, nextCursor) <= 0)
        )
          throw new Error(
            "Thread pagination did not advance. Refresh to try again.",
          );
        nextCursor = bounds
          ? (bounds.cursor ?? undefined)
          : (replies.at(-1) ?? nextCursor);
        nextPages++;
        if (speculativeBack) rawBackPages.push(response);
        else fetched = union(fetched, related(events));
        // Only strict bounds prove exhaustion. Legacy short pages may be filtered
        // after LIMIT, so an empty continuation means merely no more returned.
        more = bounds ? bounds.hasMore : replies.length > 0;
        // A page read again keeps the window's recorded boundary.
        if (kind !== "back") starts[nextPages] = nextCursor;
        else if (
          boundary &&
          more &&
          nextCursor &&
          order(nextCursor, boundary) < 0
        )
          backStarts.push(nextCursor);
        // Each older page commits as it lands, so a later failure retries
        // from the next page rather than the first.
        if (kind === "more") {
          setRemote(union(remote, fetched));
          pages = nextPages;
          hasMore = more;
        }
        if (!more) break;
      }
      if (!active()) return;
      // Replies arrived above the window since it left them: the read cap ended
      // short of its boundary, and joining the two ranges would leave a gap.
      if (boundary && more && nextCursor && order(nextCursor, boundary) < 0) {
        if (backStarts.length) {
          starts.splice(lo, 0, ...backStarts);
          lo += backStarts.length;
          pages += backStarts.length;
        }
        publish({
          status: "ready",
          error: undefined,
          readKind: undefined,
          ...paging(),
        });
        return;
      }
      if (speculativeBack && rawBackPages.length) {
        const admitted = acceptTarget(union(...rawBackPages));
        if (!active()) return;
        if (
          !admitted.some(
            (event) =>
              event.id === rootId &&
              isThreadContent(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          rootUnavailable = true;
          rewind();
          publish({ canLoadMore: false, canLoadBack: false });
          throw new Error("The original thread message is unavailable.");
        }
        fetched = related(admitted);
      }
      // A bounded response cannot retract observed evidence. Retain known edits,
      // tombstones and live rows even when a later finite read omits them. Replies
      // the re-read never reached sit past a gap it cannot show; those go, with
      // the pages read past the reader's range: as resident pages, every later
      // refresh would re-read them all.
      const unreached = mode === "older" && !reached && more;
      setRemote(
        union(
          unreached ? remote.filter((event) => !kept.has(event.id)) : remote,
          fetched,
        ),
      );
      rootUnavailable = false;
      if (kind === "back") {
        if (backStarts.length) {
          starts.splice(lo, 0, ...backStarts);
          pages += backStarts.length;
        }
        lo = first;
      } else {
        if (kind === "latest") {
          lo = 0;
          filled = false;
        }
        pages = unreached ? first + count : nextPages;
        hasMore = more;
        if (!more) starts.length = pages;
      }
      if (replace) readAt = startedAt;
      const arrived = arrivals.filter((event) => !outside(event));
      if (arrived.length) setRemote(union(remote, arrived));
      evict();
      if (!replace) reading = kind === "more" ? "end" : "start";
      shrink(kind === "more" ? "start" : kind === "back" ? "end" : away());
      // While the stream is down (a drop mid-refresh ran stale() first) the
      // held replies stand; a view holding none, or a fill that gave them up,
      // takes the replies now.
      if (replace && !dropped) held = undefined;
      else if (replace && (unreached || !held?.size)) held = unverified();
      if (replace) shown = undefined;
      if (branchSelection?.revision === selectionRevision) {
        const result =
          branchSelection.id === subthreadId
            ? "selected"
            : await readTarget(branchSelection.id, owned, rootId);
        if (!active()) return;
        if (branchSelection.revision === selectionRevision)
          targetStatus = result === "selected" ? "ready" : "unavailable";
      }
      publish({
        status: "ready",
        error: undefined,
        readKind: undefined,
        direction: mode === "older" ? "older" : "forward",
        ...paging(),
      });
    } catch (error) {
      if (active()) {
        // A relay's rejection is not one: the same read fails the same way.
        if (
          recover &&
          canRefresh() &&
          (error instanceof ReadError && error.status !== undefined
            ? transientStatus(error.status)
            : isRetryableRead(error))
        ) {
          failed = replace ? "refresh" : "older";
          // The page a person asked for is still wanted once this recovers,
          // to the frontier asked for last.
          if (kind === "more" && !sought && typeof older !== "function")
            older = through ?? true;
          else if (
            (kind === "back" || kind === "latest") &&
            queued !== "latest"
          )
            queued = kind;
          publishStatus({});
        } else if (sought && !rootUnavailable) {
          // Nobody asked for this read: its failure shows only as the parent
          // not being found. A root it found gone is the thread's failure.
          seek = null;
          publishStatus({});
        } else {
          // A failed repair stays visible with Retry; the page queued behind
          // it would clear that error.
          older = false;
          queued = false;
          if (targetStatus === "loading") targetStatus = "error";
          // A failed refresh shows what is read, as a fresh view would.
          if (replace && shown) {
            shown = undefined;
            publish();
          }
          publishStatus({
            status: "error",
            error: String(error),
            // A background read published no kind when it began, and a
            // page asked for behind it published its own.
            readKind: asked,
          });
        }
      }
    } finally {
      // Stops a read started alongside another that the run ended without.
      owned.abort();
      if (controller === owned) {
        staged = [];
        arrivals = [];
        controller = undefined;
        if (again && !disposed) {
          const established = again === "established";
          again = false;
          void run("refresh", established);
        } else advance();
        recover?.();
      }
    }
  }
  return {
    channelId,
    // Staged verified IDs allow immediate live delete-of-overlay access checks,
    // without publishing the incomplete finite overlay into any shared view.
    event: (id: string) =>
      [...remote, ...staged, ...selectionStaged].find(
        (event) => event.id === id,
      ),
    events: () => [...remote, ...staged, ...selectionStaged],
    receive,
    purge,
    /** What a later view of this thread may show at once: a settled ordinary
     * view of a root. `keep` leaves an earlier resume in place: a read runs,
     * rows are still resumed, or a retarget selected a reply, which can sit
     * outside the root's window. A retarget only to the root keeps its rows. */
    resume(): ThreadResume | "keep" | undefined {
      if (controller || shown || selectedReply || failed) return "keep";
      if (lo > 0) return undefined;
      const { status, root, replies, direction, canLoadMore, limited } =
        snapshot;
      if (
        disposed ||
        rootId !== messageId ||
        rootUnavailable ||
        status !== "ready" ||
        !root ||
        !direction
      )
        return undefined;
      return Object.freeze({
        root,
        // Pending local sends are the outbox's to show, not a resume's.
        replies: replies.filter((row) => !row.delivery),
        direction,
        canLoadMore,
        limited,
      });
    },
    /** The stream dropped: the replies held now are what its establishment
     * refresh must reach. */
    stale() {
      // Only the first drop: a later one keeps the views the first took.
      if (!dropped)
        liveAtDrop =
          snapshot.status === "ready" &&
          !controller &&
          !again &&
          !failed &&
          now() - readAt <= RESUME_READ_AGE;
      dropped = true;
      held ??= unverified();
      // A queued establishment was for the stream that just dropped.
      if (again === "established") again = "refresh";
    },
    /** The stream is back: refresh, reaching the replies held across the drop.
     * When the channel's replay was continuous (`resumed`) and the view was
     * live at the drop, the replay delivered every reply since: no read. */
    established(resumed = false) {
      const live =
        resumed &&
        liveAtDrop &&
        dropped &&
        !controller &&
        snapshot.status === "ready";
      liveAtDrop = false;
      if (!live) return run("refresh", true);
      dropped = false;
      held = undefined;
      return Promise.resolve();
    },
    localChanged() {
      const next = localOperations();
      if (
        next.length !== localInputs.length ||
        next.some((item, index) => item !== localInputs[index])
      )
        publish();
    },
    /** For session recovery: a transient failure waits for `retry`. */
    recovery: (): RecoveryStatus =>
      failed ? "failed" : recover && controller ? "busy" : "settled",
    /** `timed` is recovery's own delay. Any other retry follows a reconnect,
     * which a view the stream dropped answers with its establishment refresh. */
    retry(timed?: boolean) {
      if (!failed || (dropped && !timed)) return;
      if (failed === "refresh") return void run("refresh");
      failed = undefined;
      advance();
      // Nothing may be left to read: the wait is over either way.
      publishStatus({});
    },
    /** Profiles change the rows only through an owner the fold looked up. */
    ownersChanged() {
      for (const [pubkey, owner] of owners)
        if (agentOwner?.(pubkey) !== owner) return publish();
    },
    view: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retarget,
      refresh(selection?: Parameters<ThreadView["refresh"]>[0]) {
        if (subthreadId && !branchOpening) {
          branchOpening = selection ?? { messageId };
          messageId = branchOpening.messageId;
        }
        return run("refresh");
      },
      loadMore: more,
      loadBack: () => page("back"),
      latest: () => (mode === "older" ? page("latest") : Promise.resolve()),
      pin(id: string | undefined) {
        if (pinned === id) return;
        pinned = id;
        evict();
        publish();
      },
      dispose() {
        listeners.clear();
        purge(true);
        disposed = true;
      },
    } satisfies ThreadView,
  };
}
