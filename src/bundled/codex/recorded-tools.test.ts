import { expect, it } from "vitest";
import { codexTurns } from "./transcript";
import { restoreRecordedTools } from "./recorded-tools";

const call = (id: string) => ({
  type: "custom_tool_call",
  call_id: id,
  name: "exec",
  input: "text(await tools.buzz__read({limit: 2}));",
});
const result = (id: string) => ({
  type: "custom_tool_call_output",
  call_id: id,
  output: [
    { type: "input_text", text: "Script completed\nOutput:" },
    { type: "input_text", text: "two messages" },
    { type: "image", image_url: "data:image/png;base64,AA==" },
  ],
});
const record = (
  type: string,
  payload: unknown,
  timestamp = "2026-10-20T12:00:00Z",
) => JSON.stringify({ type, timestamp, payload });
const start = (turn_id = "turn") =>
  record("event_msg", { type: "task_started", turn_id });
const completed = (id: string, turn_id = "turn") =>
  record("event_msg", { type: "item_completed", turn_id, item: { id } });
function turns(
  native: Record<string, unknown> = {
    type: "dynamicToolCall",
    id: "nested",
    namespace: "buzz",
    tool: "read",
    arguments: { limit: 2 },
    status: "completed",
    contentItems: [{ type: "inputText", text: "two messages" }],
  },
) {
  return codexTurns(
    [
      {
        id: "turn",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "userMessage",
            id: "prompt",
            content: [{ type: "text", text: "read messages" }],
          },
          native,
          { type: "agentMessage", id: "reply", text: "Done" },
        ],
      },
    ],
    { channelId: "channel" },
  );
}

it("restores the actual exec script and results around its recorded calls, without flattening them", () => {
  const mapped = turns();
  restoreRecordedTools(
    mapped,
    [
      start(),
      completed("prompt"),
      record("response_item", call("script")),
      completed("nested"),
      record("response_item", result("script")),
      completed("reply"),
      '{"type":',
    ].join("\n"),
  );
  expect(mapped[0]?.items.map((item) => item.id)).toEqual([
    "prompt",
    "script",
    "reply",
  ]);
  const script = mapped[0]?.items[1];
  expect(script).toMatchObject({
    type: "tool",
    title: "exec",
    status: "completed",
    input: call("script").input,
    output:
      'Script completed\nOutput:\ntwo messages\n{\n  "type": "image",\n  "image_url": "data:image/png;base64,AA=="\n}',
    children: [
      {
        id: "nested",
        title: "buzz.read",
        input: JSON.stringify({ limit: 2 }, null, 2),
      },
    ],
  });
});

it.each(["string", "blocks"])(
  "keeps completed status and later grouping when %s output quotes the yielded message",
  (shape) => {
    const mapped = turns();
    const header = "Script completed\nWall time 0.1 seconds\nOutput:\n";
    const printed = "source: Script running with cell ID cell-1";
    restoreRecordedTools(
      mapped,
      [
        start(),
        completed("prompt"),
        record("response_item", call("first")),
        record("response_item", {
          type: "custom_tool_call_output",
          call_id: "first",
          output:
            shape === "string"
              ? header + printed
              : [
                  { type: "input_text", text: header },
                  { type: "input_text", text: printed },
                ],
        }),
        record("response_item", call("second")),
        completed("nested"),
        record("response_item", result("second")),
      ].join("\n"),
    );
    expect(mapped[0]?.items).toMatchObject([
      { id: "prompt" },
      {
        id: "first",
        status: "completed",
        output: expect.stringContaining(printed),
      },
      { id: "second", status: "completed", children: [{ id: "nested" }] },
      { id: "reply" },
    ]);
  },
);

it.each([
  ["Script failed", "failed"],
  ["Script terminated", "terminated"],
  ["Unrecognized wrapper", "unknown"],
])("preserves the %s wrapper status", (header, status) => {
  const mapped = turns();
  restoreRecordedTools(
    mapped,
    [
      start(),
      record("response_item", call("script")),
      record("response_item", {
        type: "custom_tool_call_output",
        call_id: "script",
        output: [
          {
            type: "input_text",
            text: `${header}\nWall time: 0.1 seconds\nOutput:\nError`,
          },
        ],
      }),
    ].join("\n"),
  );
  expect(mapped[0]?.items[0]).toMatchObject({ id: "script", status });
});

it.each([
  ["earlier", Date.parse("2026-10-20T12:00:01Z"), false],
  ["missing", undefined, false],
  ["same", Date.parse("2026-10-20T12:00:02Z"), true],
  ["later", Date.parse("2026-10-20T12:00:03Z"), true],
])(
  "uses the %s command start time to avoid attributing a delayed completion to another script",
  (_, startedAt, nested) => {
    const mapped = turns({
      type: "commandExecution",
      id: "nested",
      command: "sleep 1; false",
      status: "failed",
      aggregatedOutput: "exit 1",
    });
    restoreRecordedTools(
      mapped,
      [
        start(),
        completed("prompt"),
        record("response_item", call("a")),
        record("response_item", result("a")),
        record("response_item", call("b"), "2026-10-20T12:00:02Z"),
        record(
          "event_msg",
          {
            type: "item_completed",
            turn_id: "turn",
            started_at_ms: startedAt,
            item: { id: "nested", type: "CommandExecution" },
          },
          "2026-10-20T12:00:04Z",
        ),
        record("response_item", result("b"), "2026-10-20T12:00:05Z"),
      ].join("\n"),
    );
    const script = mapped[0]?.items.find((item) => item.id === "b");
    if (nested) {
      expect(script).toMatchObject({
        children: [{ id: "nested", status: "failed" }],
      });
      expect(mapped[0]?.items.map((item) => item.id)).toEqual([
        "prompt",
        "a",
        "b",
        "reply",
      ]);
    } else {
      expect(script).not.toHaveProperty("children");
      expect(mapped[0]?.items.map((item) => item.id)).toEqual([
        "prompt",
        "a",
        "b",
        "nested",
        "reply",
      ]);
    }
  },
);

it("keeps concurrent calls independent and does not associate a later turn with an unfinished script", () => {
  const mapped = turns();
  restoreRecordedTools(
    mapped,
    [
      start(),
      completed("prompt"),
      record("response_item", call("a")),
      record("response_item", call("b")),
      completed("nested"),
      start("another-turn"),
      record("response_item", call("outside")),
    ].join("\n"),
  );
  expect(mapped[0]?.items.map((item) => item.id)).toEqual([
    "prompt",
    "a",
    "b",
    "nested",
    "reply",
  ]);
  expect(mapped[0]?.items[1]).toMatchObject({ status: "unknown" });
  expect(mapped[0]?.items[1]).not.toHaveProperty("children");
  expect(mapped[0]?.items[2]).not.toHaveProperty("children");
});

it.each(["yielded", "overlapping"])(
  "keeps delayed calls independent after %s scripts make ownership uncertain",
  (ordering) => {
    const mapped = turns();
    const firstResult = record("response_item", {
      type: "custom_tool_call_output",
      call_id: "a",
      output: "Script running with cell ID cell-a",
    });
    restoreRecordedTools(
      mapped,
      [
        start(),
        completed("prompt"),
        record("response_item", call("a")),
        ...(ordering === "yielded" ? [firstResult] : []),
        record("response_item", {
          ...call("b"),
          input: "text(await tools.clock__curr_time({}));",
        }),
        ...(ordering === "overlapping"
          ? [record("response_item", result("a"))]
          : []),
        completed("nested"),
        record("response_item", result("b")),
      ].join("\n"),
    );
    expect(mapped[0]?.items.map((item) => item.id)).toEqual([
      "prompt",
      "a",
      "b",
      "nested",
      "reply",
    ]);
    expect(mapped[0]?.items[2]).not.toHaveProperty("children");
  },
);

it("retains yielded exec and wait inputs and outputs, including the explicit cell handle", () => {
  const mapped = turns();
  const yielded = {
    type: "custom_tool_call_output",
    call_id: "script",
    output: "Script running with cell ID cell-1",
  };
  const wait = {
    type: "function_call",
    call_id: "wait",
    namespace: "functions",
    name: "wait",
    arguments: '{"cell_id":"cell-1"}',
  };
  const finished = {
    type: "function_call_output",
    call_id: "wait",
    output: "Script completed\nOutput:\nfinal result",
  };
  restoreRecordedTools(
    mapped,
    [
      start(),
      completed("prompt"),
      record("response_item", call("script")),
      record("response_item", yielded),
      record("response_item", wait),
      completed("nested"),
      record("response_item", finished),
    ].join("\n"),
  );
  expect(mapped[0]?.items).toMatchObject([
    { id: "prompt" },
    { title: "exec", status: "yielded", output: yielded.output },
    {
      title: "wait",
      input: wait.arguments,
      output: finished.output,
    },
    { id: "nested" },
    { id: "reply" },
  ]);
});

it("keeps a delayed completion in its own turn when another turn has an active script", () => {
  const mapped = turns();
  const original = mapped[0];
  if (!original) throw new Error("Missing turn");
  mapped.push({ ...original, turnId: "new", items: [] });
  restoreRecordedTools(
    mapped,
    [
      start(),
      completed("prompt"),
      record("response_item", call("old-script")),
      record("response_item", result("old-script")),
      start("new"),
      record("response_item", call("new-script")),
      completed("nested", "turn"),
    ].join("\n"),
  );
  expect(mapped[0]?.items.map((item) => item.id)).toEqual([
    "prompt",
    "old-script",
    "nested",
    "reply",
  ]);
  expect(mapped[1]?.items).toMatchObject([{ id: "new-script" }]);
  expect(mapped[1]?.items[0]).not.toHaveProperty("children");
});

it("uses each item's recorded start, keeping the turn start for an unrecorded item", () => {
  const mapped = turns({
    type: "commandExecution",
    id: "nested",
    command: "ls",
    status: "completed",
    durationMs: 500,
    aggregatedOutput: "",
  });
  restoreRecordedTools(
    mapped,
    [
      start(),
      record("event_msg", {
        type: "item_completed",
        turn_id: "turn",
        started_at_ms: 5000,
        completed_at_ms: 7000,
        item: { id: "nested" },
      }),
      record("event_msg", {
        type: "item_completed",
        turn_id: "turn",
        started_at_ms: 8000,
        item: { id: "reply" },
      }),
    ].join("\n"),
  );
  const items = mapped[0]?.items ?? [];
  expect(items.find((item) => item.id === "prompt")).toMatchObject({
    at: 1000,
  });
  expect(items.find((item) => item.id === "nested")).toMatchObject({
    at: 5000,
    completedAt: 7000,
  });
  expect(items.find((item) => item.id === "reply")).toMatchObject({ at: 8000 });
});

it("uses a recorded finish even for a tool without a prior duration, and ignores a zero start", () => {
  const mapped = turns();
  restoreRecordedTools(
    mapped,
    [
      start(),
      record("event_msg", {
        type: "item_completed",
        turn_id: "turn",
        started_at_ms: 5000,
        completed_at_ms: 7000,
        item: { id: "nested" },
      }),
      record("event_msg", {
        type: "item_completed",
        turn_id: "turn",
        started_at_ms: 0,
        item: { id: "reply" },
      }),
    ].join("\n"),
  );
  const items = mapped[0]?.items ?? [];
  expect(items.find((item) => item.id === "nested")).toMatchObject({
    at: 5000,
    completedAt: 7000,
  });
  expect(items.find((item) => item.id === "reply")).toMatchObject({ at: 1000 });
});

it("shifts the app-server duration to the recorded start when no finish is recorded", () => {
  const mapped = turns({
    type: "commandExecution",
    id: "nested",
    command: "ls",
    status: "completed",
    durationMs: 500,
    aggregatedOutput: "",
  });
  restoreRecordedTools(
    mapped,
    [
      start(),
      record("event_msg", {
        type: "item_completed",
        turn_id: "turn",
        started_at_ms: 5000,
        item: { id: "nested" },
      }),
    ].join("\n"),
  );
  expect(mapped[0]?.items.find((item) => item.id === "nested")).toMatchObject({
    at: 5000,
    completedAt: 5500,
  });
});

const withDuration = {
  type: "commandExecution",
  id: "nested",
  command: "ls",
  status: "completed",
  durationMs: 500,
  aggregatedOutput: "",
};

it.each([
  ["no start, an app-server duration", {}, withDuration, 6500, 7000],
  [
    "a zero start, an app-server duration",
    { started_at_ms: 0 },
    withDuration,
    6500,
    7000,
  ],
  ["no start, no duration", {}, undefined, 1000, undefined],
  [
    "a zero start, no duration",
    { started_at_ms: 0 },
    undefined,
    1000,
    undefined,
  ],
] as const)(
  "never invents a duration from a recorded finish with %s",
  (_, recordedStart, item, at, completedAt) => {
    const mapped = item ? turns(item) : turns();
    restoreRecordedTools(
      mapped,
      [
        start(),
        record("event_msg", {
          type: "item_completed",
          turn_id: "turn",
          ...recordedStart,
          completed_at_ms: 7000,
          item: { id: "nested" },
        }),
      ].join("\n"),
    );
    const nested = mapped[0]?.items.find((entry) => entry.id === "nested");
    expect(nested).toMatchObject({ at });
    expect(
      nested && "completedAt" in nested ? nested.completedAt : undefined,
    ).toBe(completedAt);
  },
);

it.each([
  ["a dated", "2026-10-20T12:00:00Z", Date.parse("2026-10-20T12:00:06Z")],
  ["an undated", "", undefined],
  ["an invalid-timestamp", "not a time", undefined],
])(
  "gives %s restored exec call a finish only from a recorded start",
  (_, callTime, completedAt) => {
    const mapped = turns();
    restoreRecordedTools(
      mapped,
      [
        start(),
        record("response_item", call("script"), callTime),
        record("response_item", result("script"), "2026-10-20T12:00:06Z"),
      ].join("\n"),
    );
    const script = mapped[0]?.items.find((item) => item.id === "script");
    expect(script).toMatchObject({ status: "completed" });
    expect(
      script && "completedAt" in script ? script.completedAt : undefined,
    ).toBe(completedAt);
  },
);
