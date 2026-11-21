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

export const inject = ["react", "conversation"];

type Sort = "top" | "oldest";
type Cursor = { created_at: number; id: string };
type Lane = "older" | "newer";
type Hold = ReturnType<RelaySession["retain"]>;

const PAGE = 200;
const MORE = 260;
const HEADROOM = 200;
const SMALLEST = 20;
const JITTER_MS = 10_000;
const BOUNDS = { thread: 39007, channel: 39006 } as const;
const AUX = new Set([5, 7, 9005, 40003]);
const AUX_PAGE = 500;
const LATE_SECS = 960;

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
const inOrder = (a: Cursor, b: Cursor) =>
  a.created_at - b.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const tagged = (event: EventData, name: string, value: string) =>
  event.tags.some(([key, tag]) => key === name && tag === value);
const invalidBounds = () => new Error("The relay sent invalid window bounds");
const parsed = (content: string) => {
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    throw invalidBounds();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw invalidBounds();
  return body as Record<string, unknown>;
};
const cursorOrNull = (value: unknown) => {
  if (value == null) return null;
  const { created_at, id } = value as Partial<Cursor>;
  if (
    typeof created_at !== "number" ||
    !Number.isSafeInteger(created_at) ||
    created_at < 0 ||
    typeof id !== "string" ||
    !/^[0-9a-f]{64}$/.test(id)
  )
    throw invalidBounds();
  return { created_at, id };
};
const score = (row: ChannelMessage) =>
  new Set(row.reactions.flatMap((r) => r.events.map((e) => e.authorId))).size;
const pending = (row: ChannelMessage) =>
  row.delivery !== undefined && row.delivery !== "seen";
const cursorOf = (row: ChannelMessage) => ({
  created_at: row.createdAt,
  id: row.id,
});

function createArranger(initial: ComposerAccessoryProps) {
  let props = initial;
  let phase: Phase = { state: "idle" };
  let sort: Sort | undefined;
  let size = PAGE;
  let filter = "";
  let starts = [0];
  const events = new Map<string, RelayEvent>();
  let hold: Hold | undefined;
  let closureRefused: string | undefined;
  let scanned = false;
  let forward: Cursor | null | undefined;
  let walkStart: number | undefined;
  let shown = 0;
  let taken = 0;
  let total = 0;
  let message = "";
  let stops: (() => void)[] = [];
  let queued = false;
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
    const fresh = new Map<string, RelayEvent>();
    for (const event of more)
      if (event.kind !== kind && !events.has(event.id))
        fresh.set(event.id, event);
    holdAll([...fresh.values()]);
  }
  function holdAll(more: readonly RelayEvent[] = []) {
    try {
      hold ??= props.session.retain();
      hold.set([...events.values(), ...more]);
    } catch (error) {
      throw new Error(
        `Cannot hold this conversation: ${(error as Error).message}`,
      );
    }
    for (const event of more) events.set(event.id, event);
  }
  function forget() {
    events.clear();
    scanned = false;
    forward = undefined;
    walkStart = undefined;
    lost = false;
    hold?.dispose();
    hold = undefined;
  }

  async function drain(
    filter: ReadFilter,
    signal: AbortSignal,
    take: (page: readonly RelayEvent[]) => void,
  ) {
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await read(
        [
          {
            ...filter,
            ...(cursor
              ? { until: cursor.created_at, before_id: cursor.id }
              : {}),
          },
        ],
        signal,
      );
      const last = page.reduce<RelayEvent | undefined>(
        (end, event) => (!end || inOrder(event, end) < 0 ? event : end),
        undefined,
      );
      if (!last) return;
      if (cursor && inOrder(last, cursor) >= 0)
        throw new Error("The relay did not page this read");
      take(page);
      cursor = { created_at: last.created_at, id: last.id };
    }
  }

  async function replyAux(ids: readonly string[], signal: AbortSignal) {
    if (!ids.length) return;
    for (const scope of [
      { kinds: [5, 7, 9005, 40003], "#h": [props.channelId] },
      { kinds: [5, 9005] },
    ])
      await drain({ ...scope, "#e": [...ids], limit: AUX_PAGE }, signal, keep);
  }
  async function overlap(signal: AbortSignal) {
    const root = rootId();
    const fresh: string[] = [];
    await drain(
      {
        kinds: [9],
        "#h": [props.channelId],
        ...(root ? { "#e": [root] } : {}),
        since: (walkStart ?? 0) - LATE_SECS,
        limit: PAGE,
      },
      signal,
      (page) => {
        const rows = root
          ? page
          : page.filter(
              (event) =>
                !event.tags.some(
                  ([name, , , marker]) => name === "e" && marker === "reply",
                ),
            );
        for (const event of rows)
          if (event.id !== root && !events.has(event.id)) fresh.push(event.id);
        keep(rows);
      },
    );
    await replyAux(fresh, signal);
  }

  async function pages(
    lanes: readonly (readonly [Lane, Cursor | undefined])[],
    signal: AbortSignal,
  ) {
    const root = rootId();
    let closure = !root || closureRefused !== root;
    const windows = () =>
      lanes.map(([lane, cursor]) => {
        const newer = lane === "newer";
        return {
          "#h": [props.channelId],
          kinds: [9],
          limit: PAGE,
          include_aux: closure,
          ...(root
            ? { thread_window: true, "#e": [root], depth_limit: 100 }
            : { top_level: true }),
          ...(newer ? { direction: "newer" as const } : {}),
          ...(cursor
            ? newer
              ? { after: cursor.created_at, after_id: cursor.id }
              : { until: cursor.created_at, before_id: cursor.id }
            : {}),
        };
      });
    let answer: readonly RelayEvent[];
    const requested = Math.floor(Date.now() / 1000);
    try {
      answer = await read(windows(), signal);
    } catch (error) {
      if (!root || !closure || (error as { status?: unknown }).status !== 503)
        throw error;
      closure = false;
      answer = await read(windows(), signal);
    }
    const stamped = answer.filter(
      (event) =>
        event.kind === kindOfBounds() &&
        event.pubkey === props.session.relayAuthor,
    );
    const threadBoundsVerifiedByHost = Boolean(root);
    const bounds = lanes.map(([lane, cursor]) => {
      const at = cursor ? `${cursor.created_at}:${cursor.id}` : "head";
      const d = `${props.channelId}:${lane === "newer" ? "newer:" : ""}${at}`;
      const matching = stamped.flatMap((event) => {
        if (
          !threadBoundsVerifiedByHost &&
          !(tagged(event, "h", props.channelId) && tagged(event, "d", d))
        )
          return [];
        const body = parsed(event.content);
        return (body.direction ?? "older") === lane ? [{ event, body }] : [];
      });
      const [bound] = matching;
      if (
        matching.length !== 1 ||
        !bound ||
        typeof bound.body.has_more !== "boolean"
      )
        throw invalidBounds();
      const to = cursorOrNull(bound.body.next_cursor);
      if (
        bound.body.has_more !== (to !== null) ||
        (to && cursor && inOrder(to, cursor) * (lane === "newer" ? 1 : -1) <= 0)
      )
        throw invalidBounds();
      return { event: bound.event, to };
    });
    walkStart = Math.min(
      walkStart ?? requested,
      requested,
      ...bounds.map(({ event }) => event.created_at),
    );
    keep(answer);
    if (!closure) {
      await replyAux(
        answer
          .filter((event) => event.kind === 9 && event.id !== root)
          .map((event) => event.id),
        signal,
      );
      closureRefused = root;
    }
    return bounds.map(({ to }) => to);
  }
  const rootRead = (signal: AbortSignal) => {
    const root = rootId();
    return root && !events.has(root)
      ? read([{ ids: [root], "#h": [props.channelId], limit: 1 }], signal).then(
          keep,
        )
      : undefined;
  };

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
        if (!o || !n || inOrder(n, o) >= 0) break;
      }
    } else {
      let cursor: Cursor | null | undefined;
      while (cursor !== null) {
        [cursor] = await pages([["older", cursor ?? undefined]], signal);
        emit();
      }
    }
    await overlap(signal);
    scanned = true;
  }

  const countRows = () =>
    [...events.values()].filter((e) => e.kind === 9 && e.id !== rootId())
      .length;
  const windowEnd = () => offset() + size;
  const reached = (row: ChannelMessage) =>
    scanned ||
    forward === null ||
    (forward !== undefined && inOrder(cursorOf(row), forward) <= 0);
  const readRows = () =>
    rows().filter((row) => !pending(row) && reached(row)).length;
  async function scanForward(signal: AbortSignal) {
    await rootRead(signal);
    while (forward !== null && readRows() < windowEnd()) {
      [forward] = await pages([["newer", forward ?? undefined]], signal);
      emit();
    }
    if (forward !== null) return;
    await overlap(signal);
    scanned = true;
  }
  const reachesAll = () =>
    sort === "top" || filter !== "" || props.session.windowNewer !== true;
  const enough = () =>
    scanned ||
    (!reachesAll() && (forward === null || readRows() >= windowEnd()));
  const load = (signal: AbortSignal) =>
    reachesAll() ? scanAll(signal) : scanForward(signal);

  function arrange(place?: ConversationPresentation["place"]) {
    const { present, limits } = props;
    if (!present || !limits || !sort || phase.state !== "ready") return;
    const all = [...events.values()];
    const folded = rows();
    const needle = filter.toLowerCase();
    const matching = needle
      ? folded.filter((row) => row.content.toLowerCase().includes(needle))
      : folded;
    const mine = matching.filter(pending);
    const rest = matching.filter((row) => !pending(row) && reached(row));
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
    const pinned = sort === "top" ? mine : [];
    const tail = sort === "top" ? [] : mine;
    while (starts.length > 1 && offset() >= rest.length) starts.pop();
    const from = offset();
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
    const window = rest.slice(from, from + Math.min(size, room));
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
    const parents: Record<string, string> = {};
    for (const row of chosen) {
      const parent = row.replyParentId;
      const above = parent === undefined ? undefined : at.get(parent);
      if (parent && above !== undefined && above < (at.get(row.id) ?? 0))
        parents[row.id] = parent;
    }
    const open = [...new Set(Object.values(parents))];
    const complete = scanned && !lost && chosen.length === folded.length;
    total = rest.length;
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

  function rescan() {
    repair = undefined;
    forget();
    if (sort) refresh();
    else emit();
  }
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
      schedule();
    }
    scheduleRescan();
  }

  function onLive({ events: heard }: { events: readonly RelayEvent[] }) {
    if (!sort && !events.size) return;
    const root = rootId();
    const fresh = new Map<string, RelayEvent>();
    const known = (id: string) => events.has(id) || fresh.has(id);
    for (const event of heard)
      if (
        event.kind === 9 &&
        !known(event.id) &&
        event.tags.some(([name, id]) =>
          root
            ? name === "e" && id === root
            : name === "h" && id === props.channelId,
        )
      )
        fresh.set(event.id, event);
    for (let hop = 0; hop < 2; hop++)
      for (const event of heard)
        if (
          AUX.has(event.kind) &&
          !known(event.id) &&
          auxTargets(event).some(known)
        )
          fresh.set(event.id, event);
    if (!fresh.size) return;
    try {
      holdAll([...fresh.values()]);
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
    forget();
    emit();
  }

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
    start(next: Sort) {
      sort = next;
      size = PAGE;
      starts = [0];
      message = "";
      refresh("start");
    },
    find(text: string) {
      filter = text.trim();
      sort ??= "oldest";
      size = PAGE;
      starts = [0];
      message = "";
      refresh();
    },
    more() {
      if (phase.state !== "ready") return;
      size = Math.min(size + MORE, props.limits?.rows ?? size + MORE);
      refresh();
    },
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
    ended() {
      if (phase.state !== "ready") return;
      size = Math.max(SMALLEST, Math.floor(shown / 2));
      message = "Showing fewer rows: the reader reached its limit.";
      arrange();
    },
    free() {
      if (phase.state === "ready" && sort) arrange();
    },
    stop,
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
        } catch {}
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
    snapshot() {
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
    const was = React.useRef(props.presentation);
    React.useEffect(() => {
      const before = was.current;
      was.current = props.presentation;
      if (props.presentation === "ended") arranger.ended();
      if (props.presentation !== "none") return;
      if (before === "shown") arranger.stop();
      else arranger.free();
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
