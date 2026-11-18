import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type {
  ConversationPresentation,
  PresentationLimits,
  PresentResult,
} from "../conversation/contracts";
import { listByteSize } from "../relay/budget";
import type { ChannelMessage } from "../relay/contracts";
import type { EventData, RelayEvent } from "../relay/events";
import type { LiveBatch } from "../relay/incoming";
import { shareMessageRows } from "../relay/row-identity";
import type { RelaySession } from "../relay/session";
import { AUX, growAux, inChannel } from "../relay/threads";

/**
 * Core-internal host that shows a plugin's rows in a reader (never exported to
 * plugins). One host per reader mount, keyed by session, channel and thread.
 *
 * Four state machines, each a union below:
 * - SM1, the host: `live -> leaving -> retired`. `retire` only starts `leaving`,
 *   which a StrictMode replay's `attach` cancels in the same commit; the
 *   microtask after it tears down. `retired` is final and answers `retired`.
 * - SM2, a lane (one reader accessory): none (no entry), `holding` or `ended`.
 *   `present(P)` within limits -> `holding`; `present(null)` or unmount -> none;
 *   live growth past the limits -> `ended` (until it presents again). A
 *   boundary error unmounts the accessory, which withdraws it and revokes its
 *   `present`, so a failed lane needs no state of its own. The shown lane is the
 *   first `holding` one by `(order, key)`; the rest are held, and the next is
 *   promoted when the shown one leaves.
 * - SM3, the display: host rows (no `holding` lane) or the shown lane's rows
 *   with its evidence. Live evidence grows in place; growth past the limits ends
 *   the lane and is never trimmed (a trim could bring a deleted row back).
 * - SM4, the place intent, below: at most one pending.
 */
type LaneState =
  | Readonly<{ state: "holding"; presentation: ConversationPresentation }>
  | Readonly<{ state: "ended" }>;
/** Contributions fit: the order the accessories already have. */
export type ArrangementLane = Readonly<{
  key: string;
  order?: number | undefined;
}>;
/** The rows a reader shows in place of the host's, while a lane is shown. */
export type Display = Readonly<{
  /** The rows named by `ids` that fold, in `ids` order. */
  rows: readonly ChannelMessage[];
  /** Display parents; a reader nests with `replyTree(rows, rootId, parents.get)`.
   * Absent: the reader's own branches; an empty map: every row at the top level. */
  parents: ReadonlyMap<string, string> | undefined;
  open: readonly string[];
  complete: boolean;
  place: NonNullable<ConversationPresentation["place"]>;
  /** Changes with each presentation, not with live updates of its rows. */
  revision: number;
}>;
type Hold = ReturnType<RelaySession["retain"]>;
/** The shown lane's evidence: what the hold keeps and what the fold reads. */
type Evidence = {
  readonly hold: Hold;
  readonly ids: readonly string[];
  readonly events: Map<string, EventData>;
  /** Live aux seen, kept for ids that stay presented. */
  readonly live: Map<string, RelayEvent>;
  rows: readonly ChannelMessage[];
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exceeds = (
  events: ReadonlyMap<string, EventData>,
  l: PresentationLimits,
) => events.size > l.events || listByteSize([...events.values()]) > l.bytes;

export type Arrangement = ReturnType<typeof createArrangement>;
export function createArrangement({
  session,
  channelId,
  rootId,
  limits,
}: Readonly<{
  session: RelaySession;
  channelId: string;
  rootId?: string | undefined;
  limits: PresentationLimits;
}>) {
  let phase: "live" | "leaving" | "retired" = "live";
  const lanes = new Map<ArrangementLane, LaneState>();
  let shown: ArrangementLane | undefined;
  let evidence: Evidence | undefined;
  let display: Display | undefined;
  let revision = 0;
  let stopWatching: (() => void) | undefined;
  let cancelFrame: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const rank = (lane: ArrangementLane) =>
    Number.isFinite(lane.order) ? (lane.order as number) : 0;
  const before = (a: ArrangementLane, b: ArrangementLane) =>
    rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  /** The first holding lane by `(order, key)`, counting `candidate` as holding. */
  function leader(candidate?: ArrangementLane) {
    let best = candidate;
    for (const [lane, { state }] of lanes)
      if (state === "holding" && (!best || before(lane, best) < 0)) best = lane;
    return best;
  }
  /** The ids' rows and their aux from `live` and the plugin's events, or why not. */
  function select(
    presentation: ConversationPresentation,
    live: Iterable<EventData>,
  ) {
    if (!isObject(presentation)) return "invalid";
    const { ids, events, parents, open, complete, place } = presentation;
    // Everything `show` reads is checked here, so a bad one changes nothing.
    if (
      !Array.isArray(ids) ||
      !Array.isArray(events) ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length ||
      (parents !== undefined && !isObject(parents)) ||
      (open !== undefined && !Array.isArray(open)) ||
      (complete !== undefined && typeof complete !== "boolean") ||
      (place !== undefined &&
        place !== "keep" &&
        place !== "start" &&
        !(isObject(place) && typeof place.id === "string"))
    )
      return "invalid";
    if (ids.length > limits.rows) return "limit";
    const wanted = new Set(ids);
    const pool = new Map<string, EventData>();
    // Rows need this channel's tag; aux joins by reference, as the readers
    // admit it (a NIP-09 deletion may carry no `h`).
    for (const event of [...events, ...live])
      if (AUX.has(event.kind) || inChannel(event, channelId))
        pool.set(event.id, event);
    const held = new Map<string, EventData>();
    for (const event of pool.values())
      if (wanted.has(event.id) && !AUX.has(event.kind) && event.kind !== 39007)
        held.set(event.id, event);
    // The root, when given, stays beside its replies as the reader's header.
    const root = pool.get(rootId ?? "");
    if (root) held.set(root.id, root);
    growAux([...pool.values()], held);
    return exceeds(held, limits) ? "limit" : { events: held };
  }
  function fold(current: Evidence) {
    const folded = new Map(
      session
        .foldRows(channelId, [...current.events.values()], rootId)
        .map((row) => [row.id, row]),
    );
    // The root stays the reader's header, never a presented row.
    const rows = current.ids.flatMap((id) =>
      id === rootId ? [] : (folded.get(id) ?? []),
    );
    return shareMessageRows(current.rows, rows);
  }
  function watch() {
    if (stopWatching) return;
    const stops = [
      session.subscribeLive(onLive, { replay: true }),
      session.outbox?.subscribe(refold),
      session.profiles.subscribe(refold),
    ];
    stopWatching = () => {
      for (const stop of stops) stop?.();
    };
  }
  /** Stops showing: the display is the host's, and nothing is held or watched. */
  function release() {
    evidence?.hold.dispose();
    evidence = undefined;
    shown = undefined;
    display = undefined;
    stopWatching?.();
    stopWatching = undefined;
    cancelFrame?.();
    cancelFrame = undefined;
  }
  /** Shows `lane`'s presentation: select, hold (one swap, so evidence never has a
   * gap), fold. A reason leaves everything as it was; otherwise the selection. */
  function show(lane: ArrangementLane, presentation: ConversationPresentation) {
    const picked = select(presentation, evidence?.live.values() ?? []);
    if (typeof picked === "string") return picked;
    let hold = evidence?.hold;
    try {
      hold ??= session.retain();
      hold.set([...picked.events.values()]);
    } catch {
      // No free view slot, or past the byte bound: it does not fit.
      if (!evidence) hold?.dispose();
      return "limit";
    }
    const live = new Map(
      [...(evidence?.live ?? [])].filter(([id]) => picked.events.has(id)),
    );
    evidence = {
      hold,
      ids: [...presentation.ids],
      ...picked,
      live,
      rows: evidence?.rows ?? [],
    };
    evidence.rows = fold(evidence);
    // This fold is current, so a frame asked for by the old evidence is moot.
    cancelFrame?.();
    cancelFrame = undefined;
    shown = lane;
    revision += 1;
    display = Object.freeze({
      rows: evidence.rows,
      parents: presentation.parents
        ? new Map(
            Object.entries(presentation.parents).filter(
              ([, parent]) => typeof parent === "string",
            ),
          )
        : undefined,
      open: [...(presentation.open ?? [])],
      complete: presentation.complete === true,
      place: presentation.place ?? "keep",
      revision,
    });
    watch();
    return picked;
  }
  /** The shown lane left: promote the next holding one, which ends if it no
   * longer fits, or fall back to the host's rows. */
  function settle() {
    for (let next = leader(); next; next = leader()) {
      const lane = lanes.get(next);
      if (
        lane?.state === "holding" &&
        typeof show(next, lane.presentation) !== "string"
      ) {
        emit();
        return;
      }
      lanes.set(next, { state: "ended" });
    }
    release();
    emit();
  }
  function end() {
    if (shown) lanes.set(shown, { state: "ended" });
    settle();
  }
  function onLive({ events }: LiveBatch) {
    const current = evidence;
    if (!current) return;
    // growAux adds only aux that reaches a held event, never a row.
    const added = growAux(events, current.events);
    if (!added.length) return;
    for (const event of added) current.live.set(event.id, event);
    if (exceeds(current.events, limits)) return end();
    try {
      current.hold.set([...current.events.values()]);
    } catch {
      return end();
    }
    refold();
  }
  /** A fold at most once per frame, from live aux, the outbox or profiles. */
  function refold() {
    const current = evidence;
    if (!current || cancelFrame) return;
    const id = requestAnimationFrame(() => {
      cancelFrame = undefined;
      const rows = fold(current);
      if (current !== evidence || !display || rows === current.rows) return;
      current.rows = rows;
      display = Object.freeze({ ...display, rows });
      emit();
    });
    cancelFrame = () => cancelAnimationFrame(id);
  }
  return {
    limits,
    /** `lane` shows `presentation`, or withdraws with `null` (answering `shown`). */
    present(
      lane: ArrangementLane,
      presentation: ConversationPresentation | null,
    ): PresentResult {
      if (phase === "retired") return "retired";
      if (presentation === null) {
        lanes.delete(lane);
        if (shown === lane) settle();
        else emit();
        return "shown";
      }
      const wins = leader(lane) === lane;
      const picked = wins
        ? show(lane, presentation)
        : select(presentation, evidence?.live.values() ?? []);
      if (typeof picked === "string") return picked;
      // Only what was selected is kept, and selecting from it again gives the
      // same rows: the plugin's whole read is not held.
      const events = [...picked.events.values()];
      lanes.set(lane, {
        state: "holding",
        presentation: { ...presentation, events },
      });
      emit();
      return wins ? "shown" : "held";
    },
    status(lane: ArrangementLane): "none" | "shown" | "held" | "ended" {
      const state = lanes.get(lane)?.state;
      if (state === "holding") return shown === lane ? "shown" : "held";
      return state === "ended" ? "ended" : "none";
    },
    /** The shown presentation, or `undefined` for the host's rows. */
    snapshot: (): Display | undefined => display,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A mount, or its StrictMode replay: cancels a pending retire. */
    attach() {
      if (phase === "leaving") phase = "live";
    },
    /** An unmount, or the first half of a StrictMode replay: tears down after
     * the commit unless `attach` follows. */
    retire() {
      if (phase !== "live") return;
      phase = "leaving";
      queueMicrotask(() => {
        if (phase !== "leaving") return;
        phase = "retired";
        lanes.clear();
        release();
        emit();
      });
    },
  };
}

const noSubscription = () => () => {};
/** A reader's host and what it shows now. A thread's host exists once its root
 * does: until then no row could fold beside it. A channel's (`channel`) needs
 * no root. */
export function useArrangement(
  options: Readonly<{
    session: RelaySession;
    channelId: string;
    rootId: string | undefined;
    limits: PresentationLimits;
    channel?: boolean;
  }>,
) {
  const { session, channelId, rootId, limits, channel } = options;
  const arrangement = useMemo(
    () =>
      rootId || channel
        ? createArrangement({ session, channelId, rootId, limits })
        : undefined,
    [session, channelId, rootId, limits, channel],
  );
  useEffect(() => {
    arrangement?.attach();
    return () => arrangement?.retire();
  }, [arrangement]);
  const display = useSyncExternalStore(
    arrangement?.subscribe ?? noSubscription,
    () => arrangement?.snapshot(),
  );
  return [arrangement, display] as const;
}

/** Where a reader's view was: the row at its top, `top` px below the edge, among
 * the rows in view order. */
export type PlaceAnchor = Readonly<{
  id: string;
  top: number;
  order: readonly string[];
}>;
/** SM4, the one pending place for a reader: none (`undefined`), or one of
 * these, captured synchronously at commit and consumed once in the layout
 * effect. A new capture replaces it; a user scroll or key input cancels it. */
export type PlaceIntent =
  | Readonly<{ kind: "keep" } & PlaceAnchor>
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "end" }>
  | Readonly<{ kind: "reveal"; id: string }>;
/** What to do: put row `id` `top` px below the edge, or go to an end. */
export type Placement = Readonly<{ id: string; top: number }> | "start" | "end";

/** The nearest row to the anchor that is still shown, preferring the row below on a tie. */
export function nearestShown(
  anchor: PlaceAnchor,
  shown: (id: string) => boolean,
) {
  const index = anchor.order.indexOf(anchor.id);
  if (index < 0) return undefined;
  for (let distance = 0; distance < anchor.order.length; distance++)
    for (const at of [index + distance, index - distance]) {
      const id = anchor.order[at];
      if (id !== undefined && shown(id)) return id;
    }
  return undefined;
}

/** The intent a presentation's `place` asks for, given where the view was. A
 * withdraw is `"keep"`. With no anchor there is nothing to keep: the start. */
export function placeIntent(
  place: Display["place"],
  anchor: PlaceAnchor | undefined,
): PlaceIntent {
  if (place === "start") return { kind: "start" };
  if (place === "keep")
    return anchor ? { kind: "keep", ...anchor } : { kind: "start" };
  return { kind: "reveal", id: place.id };
}

/** SM4's holder: `none -> intent -> placement -> none`. A capture replaces
 * whatever is held; `take` resolves the intent once into a placement that stays
 * until `done` (a row in a closed branch needs another commit); input cancels. */
export function createPlace() {
  let pending: PlaceIntent | undefined;
  let held: Placement | undefined;
  return {
    capture(intent: PlaceIntent) {
      pending = intent;
      held = undefined;
    },
    cancel() {
      pending = undefined;
      held = undefined;
    },
    /** The placement to apply now, if any. `keep` goes to the nearest shown row,
     * else `fallback`. A `reveal` of a row not shown places nothing. */
    take(
      shown: (id: string) => boolean,
      fallback: "start" | "end" = "start",
    ): Placement | undefined {
      const intent = pending;
      pending = undefined;
      if (!intent) return held;
      if (intent.kind === "start" || intent.kind === "end") held = intent.kind;
      else if (intent.kind === "reveal")
        held = shown(intent.id) ? { id: intent.id, top: 0 } : undefined;
      else {
        const id = nearestShown(intent, shown);
        held = id === undefined ? fallback : { id, top: intent.top };
      }
      return held;
    },
    /** The held placement was applied, or can never be. */
    done() {
      held = undefined;
    },
  };
}

/** A reader's place keeper. The anchor is read from the rows being replaced:
 * `anchor` runs as the host announces a change, before the commit. A withdraw
 * with nothing in view follows the end, as an opening does. */
export function usePlace(
  arrangement: Arrangement | undefined,
  anchor: () => PlaceAnchor | undefined,
) {
  const place = useMemo(createPlace, []);
  const read = useEffectEvent(anchor);
  useLayoutEffect(() => {
    if (!arrangement) return;
    let seen: number | undefined;
    const capture = (at: PlaceAnchor | undefined) => {
      const next = arrangement.snapshot();
      if (next?.revision === seen) return;
      seen = next?.revision;
      place.capture(
        next || at ? placeIntent(next?.place ?? "keep", at) : { kind: "end" },
      );
    };
    // Presenting already, from before this reader could watch: no old rows.
    capture(undefined);
    return arrangement.subscribe(() => capture(read()));
  }, [arrangement, place]);
  return place;
}
