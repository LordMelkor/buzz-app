import { expect, it, vi } from "vitest";
import type { ActivityTurn } from "../../features/agents/activity";
import { requestActivity, requestActivityState } from "./request-activity";
const request = "a".repeat(64),
  agent = "b".repeat(64);
const row = (
  seq: number,
  kind: string,
  turnId = "turn",
  trigger = request,
  channelId = "alpha",
) => ({
  id: String(seq),
  agent,
  kind,
  receivedAt: 0,
  plaintext: JSON.stringify({
    seq,
    kind,
    turnId,
    channelId,
    timestamp: new Date(0).toISOString(),
    payload: { triggeringEventIds: [trigger] },
  }),
});
it("uses exact request/agent/channel starts and excludes earlier same-turn records", () => {
  const rows = [
    row(0, "acp_read"),
    row(1, "turn_started"),
    row(2, "acp_read"),
    row(3, "turn_started", "other", "c".repeat(64)),
    row(4, "acp_read", "other"),
  ];
  expect(
    requestActivity(rows, agent, "alpha", request).records.map((r) => r.id),
  ).toEqual(["1", "2"]);
  expect([...requestActivity(rows, agent, "alpha", request).turnIds]).toEqual([
    "turn",
  ]);
  expect(requestActivity(rows, "other", "alpha", request).records).toEqual([]);
  expect(requestActivity(rows, agent, "beta", request).records).toEqual([]);
  expect(requestActivity(rows, agent, "alpha", "d".repeat(64)).records).toEqual(
    [],
  );
  expect(
    requestActivity(
      rows.filter((r) => r.kind !== "turn_started"),
      agent,
      "alpha",
      request,
    ).records,
  ).toEqual([]);
});
it("parses a snapshot's records once across requests, never serving a newer snapshot stale", () => {
  const rows = Object.freeze([row(1, "turn_started"), row(2, "acp_read")]);
  const parse = vi.spyOn(JSON, "parse");
  try {
    requestActivity(rows, agent, "alpha", request);
    const parsed = parse.mock.calls.length;
    expect(parsed).toBeGreaterThan(0);
    expect(
      requestActivity(rows, agent, "alpha", "c".repeat(64)).records,
    ).toEqual([]);
    expect(
      requestActivity(rows, agent, "alpha", request).records.map((r) => r.id),
    ).toEqual(["1", "2"]);
    expect(parse.mock.calls.length).toBe(parsed);
  } finally {
    parse.mockRestore();
  }
  expect(
    requestActivity(
      [...rows, row(3, "acp_read")],
      agent,
      "alpha",
      request,
    ).records.map((r) => r.id),
  ).toEqual(["1", "2", "3"]);
});
it("does not combine reused turn IDs, conflicting sequences or inherited batch context", () => {
  const rows = [row(1, "turn_started"), row(2, "acp_read")];
  expect(
    requestActivity([...rows, row(4, "turn_started")], agent, "alpha", request)
      .records,
  ).toEqual([]);
  expect(
    requestActivity([...rows, row(2, "acp_read")], agent, "alpha", request)
      .records,
  ).toEqual([]);
  const batch = {
    ...rows[0],
    id: "batch",
    agent,
    kind: "batch",
    receivedAt: 0,
    plaintext: JSON.stringify({
      kind: "batch",
      channelId: "alpha",
      turnId: "parent",
      payload: { events: rows.map((r) => JSON.parse(r.plaintext)) },
    }),
  };
  expect(
    requestActivity([batch], agent, "alpha", request).records,
  ).toHaveLength(2);
  batch.plaintext = JSON.stringify({
    kind: "batch",
    channelId: "alpha",
    payload: {
      events: rows.map((r) => ({
        ...JSON.parse(r.plaintext),
        channelId: "beta",
      })),
    },
  });
  expect(requestActivity([batch], agent, "alpha", request).records).toEqual([]);
});

const state = (
  turnId: string,
  status: ActivityTurn["state"],
): ActivityTurn => ({
  agent,
  channelId: "alpha",
  turnId,
  state: status,
  timestamp: 0,
});
const select = (rows: ReturnType<typeof row>[]) =>
  requestActivity(rows, agent, "alpha", request);
it.each(["turn_completed", "turn_error", "agent_panic"])(
  "requires lifecycle end and exact terminal evidence for %s",
  (kind) => {
    const selected = select([row(1, "turn_started"), row(2, kind)]);
    expect(requestActivityState(selected, [state("turn", "ended")])).toBe(
      kind === "turn_completed" ? "ended" : "error",
    );
    expect(requestActivityState(selected, [state("turn", "working")])).toBe(
      "working",
    );
    expect(requestActivityState(selected, [state("turn", "unknown")])).toBe(
      "unknown",
    );
    expect(requestActivityState(selected, [])).toBe("unknown");
  },
);
it("does not settle multiple turns while another is active, unknown, missing or ambiguous", () => {
  const ended = [row(1, "turn_started"), row(2, "turn_error")];
  const both = [
    ...ended,
    row(1, "turn_started", "second"),
    row(2, "turn_completed", "second"),
  ];
  for (const [other, expected] of [
    ["working", "working"],
    ["unknown", "unknown"],
    ["ended", "error"],
  ] as const) {
    expect(
      requestActivityState(select(both), [
        state("turn", "ended"),
        state("second", other),
      ]),
    ).toBe(expected);
  }
  expect(requestActivityState(select(both), [state("turn", "ended")])).toBe(
    "unknown",
  );
  const duplicate = select([...both, row(3, "turn_started", "second")]);
  expect(duplicate.uncertain).toBe(true);
  expect(requestActivityState(duplicate, [state("turn", "ended")])).toBe(
    "unknown",
  );
  expect(requestActivityState(duplicate, [state("turn", "working")])).toBe(
    "working",
  );
  const invalidSeq = row(3, "turn_started", "second");
  invalidSeq.plaintext = invalidSeq.plaintext.replace('"seq":3', '"seq":"3"');
  expect(
    requestActivityState(select([...ended, invalidSeq]), [
      state("turn", "ended"),
    ]),
  ).toBe("unknown");
});
it("fails closed for missing terminal or evicted association, never infers from tool error", () => {
  expect(
    requestActivityState(select([row(1, "turn_started"), row(2, "acp_read")]), [
      state("turn", "ended"),
    ]),
  ).toBe("unknown");
  expect(
    requestActivityState(select([row(2, "turn_error")]), [
      state("turn", "ended"),
    ]),
  ).toBe("waiting");
  expect(requestActivityState(select([]), [state("turn", "ended")])).toBe(
    "waiting",
  );
  expect(
    requestActivityState(
      select([row(1, "turn_started"), row(2, "turn_error", "other")]),
      [state("turn", "unknown")],
    ),
  ).toBe("unknown");
});
it("validates terminal timestamps and preserves first admitted terminal receipt order", () => {
  const start = row(1, "turn_started");
  const terminal = row(2, "turn_error");
  for (const timestamp of ["invalid", new Date(5001).toISOString()]) {
    const invalid = {
      ...terminal,
      plaintext: JSON.stringify({
        ...JSON.parse(terminal.plaintext),
        timestamp,
      }),
    };
    expect(
      requestActivityState(select([start, invalid]), [state("turn", "ended")]),
    ).toBe("unknown");
    expect(
      requestActivityState(select([start, invalid, row(3, "turn_completed")]), [
        state("turn", "ended"),
      ]),
    ).toBe("ended");
  }
  expect(
    requestActivityState(select([start, row(3, "turn_completed"), terminal]), [
      state("turn", "ended"),
    ]),
  ).toBe("ended");
  expect(
    requestActivityState(select([start, terminal, row(3, "turn_completed")]), [
      state("turn", "ended"),
    ]),
  ).toBe("error");
  expect(
    requestActivityState(select([row(0, "turn_completed"), start, terminal]), [
      state("turn", "ended"),
    ]),
  ).toBe("unknown");
});
it("ignores wrong identities/channels and unscoped batch terminals", () => {
  const start = row(1, "turn_started");
  const batch = {
    ...row(2, "batch"),
    plaintext: JSON.stringify({
      kind: "batch",
      channelId: "alpha",
      payload: {
        events: [
          {
            ...JSON.parse(row(2, "turn_error").plaintext),
            channelId: undefined,
          },
        ],
      },
    }),
  };
  const selected = select([
    start,
    { ...row(2, "turn_error"), agent: "c".repeat(64) },
    row(3, "turn_error", "turn", request, "beta"),
    batch,
  ]);
  expect(requestActivityState(selected, [state("turn", "ended")])).toBe(
    "unknown",
  );
});

it("does not claim aggregate end after another linked start was trimmed", () => {
  // A's start was evicted but its lifecycle still says active; retained B ended.
  const selected = select([
    row(2, "acp_read"),
    row(3, "turn_started", "B"),
    row(4, "turn_completed", "B"),
  ]);
  const allTurns = [state("turn", "working"), state("B", "ended")];
  expect(requestActivityState(selected, allTurns, 1)).toBe("unknown");
  expect(requestActivityState(selected, [state("B", "working")], 1)).toBe(
    "working",
  );
  expect(requestActivityState(select([]), allTurns, 1)).toBe("unknown");
});
