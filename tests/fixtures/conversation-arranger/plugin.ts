import type {
  ChannelMessage,
  ComposerAccessoryProps,
  Context,
  ConversationPresentation,
  EventData,
  ReadFilter,
  RelayEvent,
  RelaySession,
} from "../../../src/plugins/author";

// Test-only installed-plugin-shaped module (never shipped): a Reddit-style
// arranger for the reader. It uses only `ctx` and the author types, and owns
// everything a user would name: the sorts, a text filter, the window size,
// "More", "Next" and "Previous" (the reader shows one window of its ranked list
// at a time, so any row is reachable), the layout of nested replies, the status
// and failure text, and the scan.
//
// The core gives it five things: `snapshotRead` (with background priority) for
// the scan, `retain` to keep what it read live, `foldRows` to fold it, the
// `newer` windows and `root_aux: false`, and `present` to show rows in the
// reader. Everything else here is its own.
export const inject = ["react", "conversation"];

type Sort = "top" | "oldest";
type Cursor = { created_at: number; id: string };
type Lane = "older" | "newer";
type Hold = ReturnType<RelaySession["retain"]>;

/** Rows per page read, and in the first window. */
const PAGE = 200;
/** Rows a "More" adds, up to the most the reader shows (460 in a thread). */
const MORE = 260;
/** Live reactions, edits and deletions the shown rows may still gain, under `limits`. */
const HEADROOM = 200;
/** The smallest slice it re-presents after `ended` or `limit`. */
const SMALLEST = 20;
/** The wait before reading again after a reconnect is up to this long, the
 * spread Buzz gives its own reconnects, so a fleet does not read in step. */
const JITTER_MS = 10_000;
const BOUNDS = { thread: 39007, channel: 39006 } as const;
const AUX = new Set([5, 7, 40003]);

/** The scan's whole life, as one value. A new sort, a withdraw or unmount aborts `scanning`. */
type Phase =
  | { state: "idle" }
  | { state: "scanning"; sort: Sort; abort: AbortController }
  | { state: "ready"; sort: Sort }
  | { state: "failed"; sort: Sort; message: string };

export type View = Readonly<{
  phase: Phase["state"];
  sort: Sort | undefined;
  /** Rows read so far. */
  read: number;
  /** Rows in the window it last presented, pinned rows included. */
  shown: number;
  /** The ranked rows the window shows are `from + 1` to `to` of `total`. */
  from: number;
  to: number;
  /** Rows that match the filter; only those read so far until `exact`. */
  total: number;
  exact: boolean;
  /** The window can grow, or move to the next or the previous one. */
  more: boolean;
  next: boolean;
  previous: boolean;
  filter: string;
  message: string;
}>;

const auxTargets = (event: EventData) =>
  event.tags.flatMap(([name, id]) => (name === "e" && id ? [id] : []));
/** The relay's `newer` order: created_at ascending, id descending. */
const inOrder = (a: Cursor, b: Cursor) =>
  a.created_at - b.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** Distinct accounts that reacted: its own definition of a score. */
const score = (row: ChannelMessage) =>
  new Set(row.reactions.flatMap((r) => r.events.map((e) => e.authorId))).size;
const pending = (row: ChannelMessage) =>
  row.delivery !== undefined && row.delivery !== "seen";
const cursorOf = (row: ChannelMessage): Cursor => ({
  created_at: row.createdAt,
  id: row.id,
});

function createArranger(initial: ComposerAccessoryProps) {
  let props = initial;
  let phase: Phase = { state: "idle" };
  let sort: Sort | undefined;
  let size = PAGE;
  /** The text a row's content must contain, ignoring case; "" shows every row. */
  let filter = "";
  /** Where each window began in the ranked list; the last is the current one. */
  let starts = [0];
  /** The events read so far, and held so their live aux reaches it. */
  const events = new Map<string, RelayEvent>();
  let hold: Hold | undefined;
  /** Every row has been read. */
  let scanned = false;
  /** The next `newer` page of an oldest-first view: undefined, its head; null, its end. */
  let forward: Cursor | null | undefined;
  let shown = 0;
  let taken = 0;
  let total = 0;
  let message = "";
  let stops: (() => void)[] = [];
  let queued = false;
  /** The live connection, and whether it dropped after rows were read: changes
   * made while it was down may never reach the plugin, so what it read is no
   * longer exact until it reads again (`rescan`, after a reconnect). */
  let connected = false;
  let lost = false;
  let repair: ReturnType<typeof setTimeout> | undefined;
  let cached: View | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    cached = undefined;
    for (const listener of [...listeners]) listener();
  };
  const rootId = () => props.threadRootId;
  const offset = () => starts.at(-1) ?? 0;
  const kindOfBounds = () => (rootId() ? BOUNDS.thread : BOUNDS.channel);
  const read = (filters: ReadFilter[], signal?: AbortSignal) => {
    const snapshot = props.session.snapshotRead;
    if (!snapshot) throw new Error("This connection cannot scan");
    return snapshot(filters, {
      priority: "background",
      ...(signal ? { signal } : {}),
    });
  };
  const rows = () =>
    props.session
      .foldRows(props.channelId, [...events.values()], rootId())
      .filter((row) => row.id !== rootId());

  function keep(more: readonly RelayEvent[]) {
    const kind = kindOfBounds();
    for (const event of more)
      if (event.kind !== kind && !events.has(event.id))
        events.set(event.id, event);
    holdAll();
  }
  /** The hold keeps everything read, so a live reaction on a row it does not
   * show still reaches `subscribeLive`. */
  function holdAll() {
    try {
      hold ??= props.session.retain();
      hold.set([...events.values()]);
    } catch (error) {
      throw new Error(
        `Cannot hold this conversation: ${(error as Error).message}`,
      );
    }
  }

  /** One read of a page for each lane asked (two thread lanes ride one read);
   * returns each lane's cursor to continue from, null at its end. */
  async function pages(
    lanes: readonly (readonly [Lane, Cursor | undefined])[],
    signal: AbortSignal,
  ) {
    const windowed = props.session.windowNewer === true;
    const root = rootId();
    const filters = lanes.map(([lane, cursor]): ReadFilter => {
      const newer = lane === "newer";
      return {
        "#h": [props.channelId],
        kinds: [9],
        limit: PAGE,
        include_aux: true,
        ...(root
          ? {
              thread_window: true,
              "#e": [root],
              depth_limit: 100,
              // The reader's header already shows the root and its reactions.
              ...(windowed ? { root_aux: false as const } : {}),
            }
          : { top_level: true }),
        ...(newer ? { direction: "newer" as const } : {}),
        ...(cursor
          ? newer
            ? { after: cursor.created_at, after_id: cursor.id }
            : { until: cursor.created_at, before_id: cursor.id }
          : {}),
      };
    });
    const answer = await read(filters, signal);
    const bodies = answer
      .filter((event) => event.kind === kindOfBounds())
      .map(
        (event) =>
          JSON.parse(event.content) as {
            direction?: Lane;
            has_more: boolean;
            next_cursor: Cursor | null;
          },
      );
    keep(answer);
    return lanes.map(([lane]) => {
      // An older bound names no direction.
      const body = bodies.find((b) => (b.direction ?? "older") === lane);
      if (!body) throw new Error("The relay sent no window bounds");
      return body.has_more ? body.next_cursor : null;
    });
  }
  const rootRead = (signal: AbortSignal) => {
    const root = rootId();
    return root && !events.has(root)
      ? read([{ ids: [root], "#h": [props.channelId], limit: 1 }], signal).then(
          keep,
        )
      : undefined;
  };

  /** Reads every row: both ends of a thread at once until they meet, else older
   * pages to the end. */
  async function scanAll(signal: AbortSignal) {
    await rootRead(signal);
    if (rootId() && props.session.windowNewer === true) {
      let older: Cursor | null | undefined;
      let newer: Cursor | null | undefined;
      for (;;) {
        const [o, n] = await pages(
          [
            ["older", older ?? undefined],
            ["newer", newer ?? undefined],
          ],
          signal,
        );
        older = o;
        newer = n;
        emit();
        // A lane that ran out walked the whole thread; the lanes are done once
        // the newer one reaches what the older one has read.
        if (!o || !n || inOrder(n, o) >= 0) break;
      }
    } else {
      let cursor: Cursor | null | undefined;
      while (cursor !== null) {
        [cursor] = await pages([["older", cursor ?? undefined]], signal);
        emit();
      }
    }
    scanned = true;
  }

  const countRows = () =>
    [...events.values()].filter((e) => e.kind === 9 && e.id !== rootId())
      .length;
  /** The rows an oldest-first window ends at. */
  const windowEnd = () => offset() + size;
  /** A row an oldest-first read has reached without a gap: at or before its
   * cursor. A live row past the cursor waits until the read reaches it. */
  const reached = (row: ChannelMessage) =>
    scanned ||
    forward === null ||
    (forward !== undefined && inOrder(cursorOf(row), forward) <= 0);
  /** Rows read so far that are not its own sends, folded as the window will be. */
  const readRows = () =>
    rows().filter((row) => !pending(row) && reached(row)).length;
  /** An oldest-first view reads forward from the start, as far as its window needs. */
  async function scanForward(signal: AbortSignal) {
    await rootRead(signal);
    while (forward !== null && readRows() < windowEnd()) {
      [forward] = await pages([["newer", forward ?? undefined]], signal);
      emit();
    }
    scanned = forward === null;
  }
  /** Ranking and filtering need every row, so a result is never partial because of
   * what happened to load. An oldest-first window reads forward only as far as it
   * reaches (without `buzz-window-newer` it cannot, so it reads it all). */
  const reachesAll = () =>
    sort === "top" || filter !== "" || props.session.windowNewer !== true;
  const enough = () =>
    scanned ||
    (!reachesAll() && (forward === null || readRows() >= windowEnd()));
  const load = (signal: AbortSignal) =>
    reachesAll() ? scanAll(signal) : scanForward(signal);

  /** Presents the window for the current sort. */
  function arrange(place?: ConversationPresentation["place"]) {
    const { present, limits, targetId } = props;
    if (!present || !limits || !sort || phase.state !== "ready") return;
    const all = [...events.values()];
    const folded = rows();
    const needle = filter.toLowerCase();
    const matching = needle
      ? folded.filter((row) => row.content.toLowerCase().includes(needle))
      : folded;
    const mine = matching.filter(pending);
    const rest = matching.filter((row) => !pending(row) && reached(row));
    // Each row's score once, not once per comparison.
    const scores = new Map(
      sort === "top" ? rest.map((row) => [row.id, score(row)]) : [],
    );
    rest.sort(
      sort === "top"
        ? (a, b) =>
            (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
            (a.id < b.id ? -1 : 1)
        : (a, b) => inOrder(cursorOf(a), cursorOf(b)),
    );
    // Its own sends stay in view; so does the message the reader opened to.
    const target = rest.find((row) => row.id === targetId);
    const pinned = [
      ...(sort === "top" ? mine : []),
      ...(target ? [target] : []),
    ];
    const tail = sort === "top" ? [] : mine;
    const queue = rest.filter((row) => row !== target);
    // A window past the end (rows were deleted, the filter narrowed) steps back.
    while (starts.length > 1 && offset() >= queue.length) starts.pop();
    const from = offset();
    // The window leaves headroom under the reader's limits for live aux.
    const auxByTarget = new Map<string, RelayEvent[]>();
    for (const event of all)
      if (AUX.has(event.kind))
        for (const id of auxTargets(event))
          auxByTarget.set(id, [...(auxByTarget.get(id) ?? []), event]);
    const cost = new Map<string, { events: number; bytes: number }>();
    const costOf = (row: ChannelMessage) => {
      let value = cost.get(row.id);
      if (!value) {
        const first = auxByTarget.get(row.id) ?? [];
        const group = [
          events.get(row.id),
          ...first,
          ...first.flatMap((e) => auxByTarget.get(e.id) ?? []),
        ].filter((e): e is RelayEvent => !!e);
        value = {
          events: group.length,
          bytes: group.reduce((sum, e) => sum + JSON.stringify(e).length, 0),
        };
        cost.set(row.id, value);
      }
      return value;
    };
    const spare = {
      events: Number.isFinite(limits.events)
        ? limits.events - HEADROOM - 1
        : Infinity,
      bytes: limits.bytes - 256 * 1024,
    };
    const chosen: ChannelMessage[] = [];
    let count = 0;
    let bytes = 0;
    const room = Math.max(0, limits.rows - pinned.length - tail.length);
    const window = queue.slice(from, from + Math.min(size, room));
    for (const row of [...pinned, ...window, ...tail]) {
      const c = costOf(row);
      if (
        chosen.length >= limits.rows ||
        count + c.events > spare.events ||
        bytes + c.bytes > spare.bytes
      )
        break;
      chosen.push(row);
      count += c.events;
      bytes += c.bytes;
    }
    const ids = chosen.map((row) => row.id);
    const inWindow = new Set(window);
    const at = new Map(ids.map((id, index) => [id, index]));
    // A reply nests under its signed parent when that parent is shown above it.
    const parents: Record<string, string> = {};
    for (const row of chosen) {
      const parent = row.replyParentId;
      const above = parent === undefined ? undefined : at.get(parent);
      if (parent && above !== undefined && above < (at.get(row.id) ?? 0))
        parents[row.id] = parent;
    }
    const open = [...new Set(Object.values(parents))];
    const complete = scanned && !lost && chosen.length === folded.length;
    total = queue.length;
    taken = chosen.filter((row) => inWindow.has(row)).length;
    const result = present({
      ids,
      events: all,
      parents,
      open,
      complete,
      ...(place ? { place } : {}),
    });
    if (result === "limit" && size > SMALLEST) {
      // Over a bound it could not see: show half as many.
      size = Math.max(SMALLEST, Math.floor(chosen.length / 2));
      return arrange(place);
    }
    if (result === "retired") return stop();
    if (result === "invalid" || result === "limit") {
      phase = {
        state: "failed",
        sort,
        message: `Cannot show rows (${result})`,
      };
    } else {
      shown = ids.length;
    }
    emit();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      arrange();
    });
  }

  function fail(error: unknown, next: Sort) {
    phase = {
      state: "failed",
      sort: next,
      message: error instanceof Error ? error.message : String(error),
    };
    emit();
  }

  /** After a reconnect: forget what was read and read it again, keeping the
   * window. The reader keeps showing (and updating) the rows it was given until
   * the new read presents. */
  function rescan() {
    repair = undefined;
    lost = false;
    events.clear();
    scanned = false;
    forward = undefined;
    try {
      hold?.set([]);
    } catch {
      // An empty hold always fits.
    }
    if (sort) refresh();
    else emit();
  }
  /** The one way a lost read is read again: while connected and visible
   * (most open panes are not), after a random wait. A failed read stays
   * failed until the person picks a sort again. */
  function scheduleRescan() {
    clearTimeout(repair);
    repair = undefined;
    if (lost && connected && document.visibilityState !== "hidden")
      repair = setTimeout(rescan, Math.random() * JITTER_MS);
  }
  function onConnection() {
    const now = props.session.live.snapshot().status === "connected";
    if (now === connected) return;
    connected = now;
    if (!now && events.size && !lost) {
      lost = true;
      emit();
    }
    scheduleRescan();
  }

  function onLive({ events: heard }: { events: readonly RelayEvent[] }) {
    // Nothing read, nothing to keep: a scan reads what arrives meanwhile.
    if (!sort && !events.size) return;
    const root = rootId();
    // A new reply to this thread, or any new message of this channel (the fold
    // keeps only its top level); then the aux of what it holds, two hops (a
    // reaction, then its deletion), so one batch can carry a row and its aux.
    let added = 0;
    for (const event of heard)
      if (
        event.kind === 9 &&
        !events.has(event.id) &&
        event.tags.some(([name, id]) =>
          root
            ? name === "e" && id === root
            : name === "h" && id === props.channelId,
        )
      ) {
        events.set(event.id, event);
        added++;
      }
    for (let hop = 0; hop < 2; hop++)
      for (const event of heard)
        if (
          AUX.has(event.kind) &&
          !events.has(event.id) &&
          auxTargets(event).some((id) => events.has(id))
        ) {
          events.set(event.id, event);
          added++;
        }
    if (!added) return;
    try {
      holdAll();
    } catch (error) {
      if (sort) fail(error, sort);
      return;
    }
    schedule();
  }

  function stop() {
    if (phase.state === "scanning") phase.abort.abort();
    phase = { state: "idle" };
    sort = undefined;
    filter = "";
    starts = [0];
    shown = 0;
    emit();
  }

  /** Reads what the view needs, then presents it: one flow for every change of
   * sort, filter and window. A newer change aborts the one still reading. */
  function refresh(place?: ConversationPresentation["place"]) {
    if (!sort) return;
    const current = sort;
    if (phase.state === "scanning") phase.abort.abort();
    if (enough()) {
      phase = { state: "ready", sort: current };
      return arrange(place);
    }
    const abort = new AbortController();
    phase = { state: "scanning", sort: current, abort };
    emit();
    void load(abort.signal).then(
      () => {
        if (abort.signal.aborted) return;
        phase = { state: "ready", sort: current };
        arrange(place);
      },
      (error) => {
        if (!abort.signal.aborted) fail(error, current);
      },
    );
  }

  const api = {
    /** Starts, or restarts, a sort from its first window. */
    start(next: Sort) {
      sort = next;
      size = PAGE;
      starts = [0];
      message = "";
      refresh(props.targetId ? { id: props.targetId } : "start");
    },
    /** Filters the rows, case-insensitively, from the first window of the current sort. */
    find(text: string) {
      filter = text.trim();
      sort ??= "oldest";
      size = PAGE;
      starts = [0];
      message = "";
      refresh(props.targetId ? { id: props.targetId } : "start");
    },
    /** Grows the window, reading further forward when the rows are not there yet. */
    more() {
      if (phase.state !== "ready") return;
      size = Math.min(size + MORE, props.limits?.rows ?? size + MORE);
      refresh();
    },
    /** Moves the window to the rows after it, or back to the ones before. */
    page(step: 1 | -1) {
      if (phase.state !== "ready") return;
      if (step === 1) starts.push(offset() + taken);
      else if (starts.length > 1) starts.pop();
      refresh("start");
    },
    withdraw() {
      props.present?.(null);
      stop();
    },
    /** Live growth passed the reader's limits: it ended this presentation. */
    ended() {
      if (phase.state !== "ready") return;
      size = Math.max(SMALLEST, Math.floor(shown / 2));
      message = "Showing fewer rows: the reader reached its limit.";
      arrange();
    },
    /** The accessory it waited behind left: present what it is showing. */
    free() {
      if (phase.state === "ready" && sort) arrange();
    },
    update(next: ComposerAccessoryProps) {
      props = next;
    },
    attach() {
      const session = props.session;
      stops = [
        session.subscribeLive(onLive),
        session.live.subscribe(onConnection),
        session.outbox?.subscribe(schedule) ?? (() => {}),
        () => document.removeEventListener("visibilitychange", scheduleRescan),
      ];
      document.addEventListener("visibilitychange", scheduleRescan);
      connected = session.live.snapshot().status === "connected";
      scheduleRescan();
      if (events.size) {
        try {
          holdAll();
        } catch {
          // The scan is kept; it is held again on its next read.
        }
      }
    },
    dispose() {
      for (const stopListening of stops.splice(0)) stopListening();
      if (phase.state === "scanning") phase.abort.abort();
      clearTimeout(repair);
      repair = undefined;
      hold?.dispose();
      hold = undefined;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(): View {
      const more = !!sort && scanned === false && forward !== null;
      const next = offset() + taken < total || more;
      cached ??= Object.freeze({
        phase: phase.state,
        sort,
        read: countRows(),
        shown,
        from: offset(),
        to: offset() + taken,
        total,
        exact: scanned && !lost,
        more: next && size < (props.limits?.rows ?? size),
        next,
        previous: starts.length > 1,
        filter,
        message: phase.state === "failed" ? phase.message : message,
      });
      return cached;
    },
  };
  return api;
}

export function apply(ctx: Context) {
  const React = ctx.react;
  const h = React.createElement;

  function Bar(props: ComposerAccessoryProps) {
    const arranger = React.useMemo(
      () => createArranger(props),
      // A new conversation is a new scan.
      [props.session, props.channelId, props.threadRootId],
    );
    React.useLayoutEffect(() => arranger.update(props));
    React.useEffect(() => {
      arranger.attach();
      return () => arranger.dispose();
    }, [arranger]);
    const view = React.useSyncExternalStore(
      arranger.subscribe,
      arranger.snapshot,
      arranger.snapshot,
    );
    React.useEffect(() => {
      if (props.presentation === "ended") arranger.ended();
      if (props.presentation === "none") arranger.free();
    }, [arranger, props.presentation]);
    const noun = props.threadRootId !== undefined ? "replies" : "messages";
    const [draft, setDraft] = React.useState("");
    React.useEffect(() => setDraft(view.filter), [view.filter]);
    const button = (label: string, run: () => void, pressed?: boolean) =>
      h(
        "button",
        {
          type: "button",
          onClick: run,
          ...(pressed === undefined ? {} : { "aria-pressed": pressed }),
        },
        label,
      );
    const count = new Intl.NumberFormat("en-US").format;
    const where = view.total
      ? `${noun[0]?.toUpperCase()}${noun.slice(1)} ${count(view.from + 1)}–${count(view.to)} of ${count(view.total)}${view.exact ? "" : "+"}`
      : `No ${noun}${view.filter ? " match" : ""}`;
    const ready = view.phase === "ready";
    return h(
      "div",
      { role: "toolbar", "aria-label": "Arrange rows" },
      button("Oldest", () => arranger.start("oldest"), view.sort === "oldest"),
      button("Top", () => arranger.start("top"), view.sort === "top"),
      h(
        "form",
        {
          role: "search",
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault();
            arranger.find(draft);
          },
        },
        h("input", {
          type: "search",
          "aria-label": `Filter ${noun}`,
          value: draft,
          onChange: (event: { target: { value: string } }) =>
            setDraft(event.target.value),
        }),
      ),
      ready && view.previous
        ? button("Previous", () => arranger.page(-1))
        : null,
      ready && view.next ? button("Next", () => arranger.page(1)) : null,
      ready && view.more ? button("More", () => arranger.more()) : null,
      view.phase === "failed" && view.sort
        ? button("Retry", () => arranger.start(view.sort as Sort))
        : null,
      view.sort ? button("Buzz order", () => arranger.withdraw()) : null,
      h(
        "span",
        { role: "status" },
        view.phase === "scanning"
          ? `Reading… ${view.read} rows`
          : view.phase === "failed"
            ? `Scan failed: ${view.message}`
            : view.sort
              ? `${where}${props.presentation === "held" ? " (waiting)" : ""} ${view.message}`.trim()
              : "",
      ),
    );
  }

  ctx.conversation.registerAccessory({
    id: "arranger",
    title: "Arranger",
    placement: "reader",
    component: Bar,
  });
}
