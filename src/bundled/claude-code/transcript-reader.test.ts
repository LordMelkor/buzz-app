import { strictEqual } from "node:assert/strict";
import { expect, it } from "vitest";
import type { TranscriptTurn } from "../../features/agents/activity-transcript";
import { focusHistory, type ReaderState, transition } from "./tabs";

type Event = Parameters<typeof transition>[1];
type Active = Pick<NonNullable<ReaderState["active"]>, "phase" | "id">;

const initial: ReaderState = { refresh: 0 };
const input = "session";
const read = Symbol("read");
const poll = Symbol("poll");
const next = Symbol("next");

function turn(turnId: string, startedAt: number) {
  return {
    turnId,
    startedAt,
    channelId: null,
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    partial: false,
    items: [],
  } satisfies TranscriptTurn;
}

const earlier = turn("earlier", 1);
const latest = turn("latest", 2);
const tied = turn("tied", 2);
const finished = { ...latest, endedAt: 3 };
const complete = { turns: [earlier, latest], more: false };
const preview = { turns: [latest], more: true };
const tail = [finished];

function begin(
  id: symbol,
  working: boolean,
  attempt = 0,
  held?: readonly TranscriptTurn[],
  session = input,
) {
  return {
    type: "begin",
    id,
    input: session,
    again: `${session}/${attempt}`,
    attempt,
    working,
    ...(held && { held }),
  } satisfies Event;
}

function drive(state: ReaderState, ...events: Event[]) {
  let result: ReturnType<typeof transition> = { state };
  for (const event of events) result = transition(result.state, event);
  return result;
}

const phase = (state: ReaderState) => state.active?.phase;
const refresh = { type: "refresh", input } satisfies Event;
const abortPoll = { type: "abort", id: poll } as const;

function fullSeed(result?: typeof complete & { incomplete?: string }) {
  return drive(
    initial,
    begin(read, false),
    { type: "preview", id: read },
    { type: "full", id: read, ...(result && { result }) },
  ).state;
}

const seeds = {
  complete: fullSeed(complete),
  partial: drive(initial, begin(read, false), {
    type: "preview",
    id: read,
    result: preview,
  }).state,
  incomplete: fullSeed({ ...complete, incomplete: "session unavailable" }),
  absent: initial,
};
const live = drive(seeds.complete, begin(read, true), {
  type: "tail",
  id: read,
  turns: tail,
}).state;
const startPoll = begin(poll, true, 0, [earlier, finished]);

it("expands a settled preview on manual Refresh and resumes with a working tail", () => {
  const pending = drive(seeds.partial, refresh, begin(read, false)).state;
  expect(phase(pending)).toBe("full");
  const { state } = drive(pending, {
    type: "full",
    id: read,
    result: complete,
  });
  expect(state.settled?.result).toEqual(complete);
  expect(state.full?.loaded).toBe(true);
  expect(phase(drive(state, begin(next, true)).state)).toBe("tail");
});

it("keeps manual Refresh queued during the first preview", () => {
  const pending = drive(initial, begin(read, false), refresh).state;
  expect(phase(pending)).toBe("preview");
  const { state } = drive(pending, {
    type: "preview",
    id: read,
    result: preview,
  });
  expect(state.settled).toMatchObject({
    refresh: 0,
    result: { partial: true },
  });
  expect(phase(drive(state, begin(next, false)).state)).toBe("full");
});

it("preserves confirmed loaded history when manual Refresh is requested", () => {
  const requested = drive(seeds.complete, refresh).state;
  const nextFocus = opening();
  const idle = focusHistory(undefined, input, undefined);
  expect(focusHistory(idle, input, nextFocus, requested.full)).toBe(idle);
  expect(phase(drive(requested, begin(read, true)).state)).toBe("full");
});

it("keeps manual Refresh scoped to the input it was requested for", () => {
  const other = "replacement";
  const replacement = begin(next, false, 0, undefined, other);
  const opened = drive(seeds.partial, refresh, replacement).state;
  expect(phase(opened)).toBe("preview");

  const refreshed = drive(
    opened,
    { type: "preview", id: next, result: preview },
    { type: "refresh", input: other },
    begin(read, false, 0, undefined, other),
  ).state;
  expect(phase(refreshed)).toBe("full");
});

it("retries full history on the next working change after a failed manual Refresh", () => {
  const pending = drive(seeds.partial, refresh, begin(read, true)).state;
  expect(phase(pending)).toBe("full");
  const failed = drive(pending, { type: "full", id: read, failed: true }).state;
  expect(failed.active).toBeUndefined();
  expect(failed.settled).toBeUndefined();
  expect(phase(drive(failed, begin(next, false)).state)).toBe("full");
});

it.each([
  { request: "manual Refresh", events: [refresh], command: "full" },
  { request: "automatic read", events: [], command: "preview" },
] as const)(
  "retries $command when work stops during a $request",
  ({ events, command }) => {
    const pending = drive(seeds.partial, ...events, begin(read, true)).state;
    expect(phase(pending)).toBe(command);
    const stopped = drive(pending, { type: "abort", id: read }).state;
    const stale = transition(stopped, {
      type: command,
      id: read,
      result: command === "full" ? complete : preview,
    });
    expect(stale.ignored).toBe(true);
    expect(stale.state.settled).toBeUndefined();
    expect(phase(drive(stale.state, begin(next, false)).state)).toBe(command);
  },
);

it.each([
  ["complete", "tail"],
  ["partial", "preview"],
  ["incomplete", "full"],
  ["absent", "preview"],
] as const)(
  "handles a working change with %s history by reading %s",
  (seed, command) => {
    expect(phase(drive(seeds[seed], begin(next, true)).state)).toBe(command);
  },
);

it.each([
  ["reordered same-time rows", [earlier, tied, latest]],
  [
    "a row dated before the retained prefix",
    [{ ...latest, startedAt: 0 }, tied],
  ],
  ["an unrelated window", [turn("unrelated", 4)]],
  ["an empty window", []],
] as const)("reads full history when the working tail has %s", (_, turns) => {
  const seed = fullSeed({ ...complete, turns: [earlier, latest, tied] });
  const { state } = drive(seed, begin(next, true), {
    type: "tail",
    id: next,
    turns,
  });
  expect(phase(state)).toBe("full");
});

it("carries rows accepted by a poll into the next working-edge tail", () => {
  const appended = turn("appended", 4);
  const turns = [finished, appended];
  const accepted = drive(
    seeds.complete,
    begin(poll, false, 0, complete.turns),
    { type: "poll", id: poll, turns },
  );
  expect(accepted.turns).toEqual(turns);
  const { state } = drive(accepted.state, begin(next, true), {
    type: "tail",
    id: next,
    turns: [appended],
  });
  expect(state.settled?.result.turns).toEqual([earlier, finished, appended]);
});

it("keeps the baseline after an aborted poll and ignores its late result", () => {
  const stopped = drive(live, startPoll, abortPoll).state;
  expect(stopped.active).toBeUndefined();
  const late = transition(stopped, { type: "poll", id: poll, turns: tail });
  expect(late.ignored).toBe(true);
  expect(late.turns).toBeUndefined();
  expect(phase(drive(late.state, begin(next, false)).state)).toBe("tail");
});

it("keeps a queued Refresh when work stops during a poll", () => {
  const { state } = drive(
    live,
    startPoll,
    refresh,
    abortPoll,
    begin(next, false),
  );
  expect(phase(state)).toBe("full");
});

it("does not preview again after a full read finds no transcript", () => {
  const missing = fullSeed();
  expect(phase(drive(missing, begin(next, false)).state)).toBe("full");
  const idle = focusHistory(undefined, input, undefined);
  expect(focusHistory(idle, input, opening(), missing.full).attempt).toBe(1);
});

it("keeps the full-read requirement if an invalid poll is followed by an abort", () => {
  const rejected = drive(seeds.partial, begin(poll, false, 0, preview.turns), {
    type: "poll",
    id: poll,
    turns: [turn("unrelated", 4)],
  });
  expect(rejected.turns).toBeUndefined();
  const { state } = drive(rejected.state, abortPoll, begin(next, true));
  expect(phase(state)).toBe("full");
});

it.each([
  {
    scenario: "a successful tail",
    responses: [{ type: "tail", id: read, turns: tail }],
  },
  {
    scenario: "a full fallback after a failed tail",
    responses: [
      { type: "tail", id: read, failed: true },
      { type: "full", id: read, result: complete },
    ],
  },
] as const)("keeps a Refresh queued during $scenario", ({ responses }) => {
  const { state } = drive(
    seeds.complete,
    begin(read, true),
    refresh,
    ...responses,
  );
  expect(state.settled?.refresh).toBe(0);
  expect(phase(drive(state, begin(next, false)).state)).toBe("full");
});

const opening = () => ({ events: ["event"], inputs: 1, done() {} });

it("starts focused with a full read and retries once per new focus after a failure", () => {
  const focus = opening();
  const first = focusHistory(undefined, input, focus);
  const reading = transition(initial, begin(read, false, first.attempt));
  expect(phase(reading.state)).toBe("full");
  const failed = transition(reading.state, {
    type: "full",
    id: read,
    failed: true,
  });
  expect(failed.state.active).toBeUndefined();
  expect(focusHistory(first, input, focus, failed.state.full)).toBe(first);
  expect(focusHistory(first, input, opening(), failed.state.full).attempt).toBe(
    2,
  );
});

it("keeps Load earlier in flight on the same focus and reuses loaded history on a new focus", () => {
  const focus = opening();
  const loading = { ...focusHistory(undefined, input, focus), loading: true };
  expect(focusHistory(loading, input, focus)).toBe(loading);
  expect(focusHistory(loading, input, opening())).toMatchObject({
    attempt: loading.attempt + 1,
    loading: true,
  });
  expect(focusHistory(loading, input, opening(), seeds.complete.full)).toBe(
    loading,
  );
});

function success({ phase, id }: Active) {
  return (
    phase === "tail" || phase === "poll"
      ? { type: phase, id, turns: tail }
      : { type: phase, id, result: phase === "preview" ? preview : complete }
  ) satisfies Event;
}

function alphabet(
  state: ReaderState,
  previous: Active | undefined,
  depth: number,
) {
  const current = state.active;
  return [
    refresh,
    begin(Symbol(), false),
    begin(Symbol(), true),
    begin(Symbol(), true, 0, state.settled?.result.turns ?? preview.turns),
    current && { type: "abort", id: current.id },
    current && success(current),
    previous && success(previous),
    previous && { type: "abort", id: previous.id },
    current && {
      type: current.phase,
      id: current.id,
      ...(depth % 2 === 0 && { failed: true as const }),
    },
  ] satisfies (Event | undefined)[];
}

function verify(
  before: ReaderState,
  event: Event,
  result: ReturnType<typeof transition>,
  refresh: number,
  entryRefresh: number,
  record: (witness: string) => void,
  path: string,
) {
  const { active, settled, full } = result.state;
  strictEqual(result.state.refresh, refresh, path);

  if (event.type === "refresh") {
    strictEqual(active, before.active, path);
    strictEqual(settled, before.settled, path);
    strictEqual(full?.input, event.input, path);
    const alreadyLoaded =
      before.full?.input === event.input && before.full.loaded;
    strictEqual(full?.loaded, alreadyLoaded, path);
    if (active) record("Refresh while a read is active");
    return;
  }
  if (event.type === "begin") {
    strictEqual(active?.id, event.id, path);
    strictEqual(full, before.full, path);
    const prior = before.settled;
    if (event.held) {
      strictEqual(active?.phase, "poll", path);
      strictEqual(settled, prior, path);
    } else {
      const usable =
        prior &&
        prior.again === event.again &&
        prior.working !== event.working &&
        !prior.result.partial &&
        !prior.result.incomplete;
      const eligible = !!usable && prior.refresh === refresh;
      const command = eligible
        ? "tail"
        : event.attempt || full?.input === event.input
          ? "full"
          : "preview";
      strictEqual(active?.phase, command, path);
      strictEqual(settled, undefined, path);
      if (eligible) record("working tail");
      if (usable && !eligible) record("Refresh bypasses a working tail");
    }
    return;
  }
  const stale = event.id !== before.active?.id;
  if (stale || event.type === "abort") {
    strictEqual(result.ignored, stale ? true : undefined, path);
    strictEqual(result.turns, undefined, path);
    strictEqual(settled, before.settled, path);
    strictEqual(full, before.full, path);
    strictEqual(active, stale ? before.active : undefined, path);
    if (stale && active) record(`stale ${event.type}`);
    if (!stale && before.active?.phase === "poll" && settled)
      record("abort with poll baseline");
    return;
  }

  const hasValue =
    "turns" in event
      ? !!event.turns?.length
      : "result" in event && !!event.result;
  if (event.type === "full" && !event.failed) {
    strictEqual(full?.input, before.active?.input, path);
    strictEqual(full?.loaded, hasValue, path);
  } else if (event.type === "full" || event.type === "preview") {
    strictEqual(full, before.full, path);
  }
  if (event.failed) record(`failed ${event.type}`);
  else if (!hasValue) record(`missing ${event.type}`);
  if (event.type === "poll") {
    strictEqual(active, undefined, path);
    const expected = hasValue ? before.settled?.refresh : undefined;
    strictEqual(settled?.refresh, expected, path);
    return;
  }

  const fallback =
    !hasValue &&
    (event.type === "tail" || (event.type === "preview" && !event.failed));
  strictEqual(active?.id, fallback ? event.id : undefined, path);
  strictEqual(active?.phase, fallback ? "full" : undefined, path);
  strictEqual(settled?.refresh, hasValue ? entryRefresh : undefined, path);
  if (hasValue && entryRefresh < refresh) record("settles with Refresh queued");
}

it.each(Object.entries(seeds))(
  "checks all five-event sequences from %s history",
  (seed, initialState) => {
    const witnesses = new Map<string, number>();
    const record = (name: string) =>
      witnesses.set(name, (witnesses.get(name) ?? 0) + 1);
    const path: string[] = [];
    let leaves = 0;

    function visit(
      state: ReaderState,
      refresh: number,
      entryRefresh: number,
      previous?: Active,
    ) {
      if (path.length === 5) {
        leaves++;
        return;
      }
      for (const [index, event] of alphabet(
        state,
        previous,
        path.length,
      ).entries()) {
        path.push(
          event ? `${index + 1} ${event.type}` : `${index + 1} skipped`,
        );
        if (event) {
          const refreshed = refresh + Number(event.type === "refresh");
          const entered = event.type === "begin" ? refresh : entryRefresh;
          const result = transition(state, event);
          verify(
            state,
            event,
            result,
            refreshed,
            entered,
            record,
            path.join(" → "),
          );
          const retired =
            state.active && result.state.active?.id !== state.active.id;
          visit(
            result.state,
            refreshed,
            entered,
            retired ? state.active : previous,
          );
        } else {
          visit(state, refresh, entryRefresh, previous);
        }
        path.pop();
      }
    }

    visit(initialState, 0, 0);
    expect(leaves).toBe(59_049);
    const first =
      seed === "complete" || seed === "incomplete" ? "full" : "preview";
    for (const witness of [
      "Refresh while a read is active",
      "working tail",
      "Refresh bypasses a working tail",
      "abort with poll baseline",
      "stale abort",
      `stale ${first}`,
      "settles with Refresh queued",
      "failed poll",
      "missing poll",
      `failed ${first}`,
      `missing ${first}`,
    ]) {
      expect(witnesses.get(witness), witness).toBeGreaterThan(0);
    }
  },
);
