// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptPanel } from "../../features/agents/TranscriptPanel";
import type { TranscriptTurn } from "../../features/agents/activity-transcript";
import type { Agent } from "../../features/agents/service";
import { ClaudeDefaults } from "./defaults";
import { ClaudeRuntime, type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { createTabs } from "./tabs";
import type { ClaudeTranscript } from "./transcript";

vi.mock("../../features/agents/TranscriptPanel", { spy: true });

const agent: Agent<Config> = {
  key: "c".repeat(64),
  pubkey: "c".repeat(64),
  owner: "a".repeat(64),
  name: "Claude",
  type: "buzz.claude-code/claude-code",
  relay: "wss://example.org",
  place: "here",
  config: DEFAULT_CONFIG,
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: false,
};

afterEach(() => {
  cleanup();
  vi.mocked(TranscriptPanel).mockReset();
  vi.restoreAllMocks();
  localStorage.clear();
});

function openReader(working: boolean) {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent.key]: { channel: { id: "kept", seen: 0, at: 1 } },
    }),
  );
  const runtime = new ClaudeRuntime(
    {},
    () => undefined,
    async () => undefined,
  );
  const sessions = vi
    .spyOn(runtime, "sessions")
    .mockReturnValue([{ key: "channel", busy: working }]);
  const preview = vi.spyOn(runtime, "transcriptPreview");
  const full = vi.spyOn(runtime, "transcript");
  const tail = vi.spyOn(runtime, "latestTurns");
  const panel = vi.mocked(TranscriptPanel).mockReturnValue(<section />);
  const { ActivityTab } = createTabs({
    runtime,
    defaults: new ClaudeDefaults(),
    setup: new ClaudeSetup(undefined),
  });
  const view = () => <ActivityTab agent={agent} />;
  const { rerender } = render(view());
  fireEvent.click(screen.getByRole("button", { name: /^View transcript/ }));

  function callbacks() {
    const props = panel.mock.lastCall?.[0];
    if (!props?.readLatest)
      throw new Error("Claude transcript reader did not open");
    return { read: props.read, readLatest: props.readLatest };
  }
  function setWorking(next: boolean) {
    sessions.mockReturnValue([{ key: "channel", busy: next }]);
    rerender(view());
    expect(panel.mock.lastCall?.[0].working).toBe(next);
  }

  return { callbacks, preview, full, tail, setWorking };
}

function turn(turnId: string, startedAt = 1) {
  return {
    turnId,
    startedAt,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    sessionId: "kept",
    newSession: false,
    config: [],
    partial: false,
    items: [],
  } satisfies TranscriptTurn;
}

const transcript = (...turns: TranscriptTurn[]) => ({ more: false, turns });
const activeSignal = () => new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function cancelPoll(
  reader: ReturnType<typeof openReader>,
  held: readonly TranscriptTurn[],
  reply: TranscriptTurn[],
  timing: "before" | "after",
) {
  const rawPoll = deferred<TranscriptTurn[]>();
  reader.tail.mockReturnValueOnce(rawPoll.promise);
  const controller = new AbortController();
  const reason = new Error("Poll superseded");
  const cancel = () => rawPoll.promise.then(() => controller.abort(reason));
  const beforeObservation = timing === "before" ? cancel() : undefined;
  const polling = reader.callbacks().readLatest(controller.signal, held);
  const settlement = polling.catch((error: unknown) => error);
  expect(reader.tail).toHaveBeenCalledOnce();
  const canceled = beforeObservation ?? cancel();
  rawPoll.resolve(reply);
  await canceled;
  expect(await settlement).toBe(reason);
}

it.each([
  { timing: "before", mode: "preview" },
  { timing: "after", mode: "full" },
] as const)(
  "reads $mode when invalid overlap at the cancellation boundary is aborted $timing observation",
  async ({ timing, mode }) => {
    const reader = openReader(true);
    const held = turn("previewed turn");
    const replacement = turn("new after cancellation", 2);
    const nextPreview = transcript(replacement);
    const nextFull = transcript(turn("earlier history"), replacement);
    reader.preview
      .mockResolvedValueOnce(transcript(held))
      .mockResolvedValueOnce(nextPreview);
    reader.full.mockResolvedValue(nextFull);
    const initial = await reader.callbacks().read(activeSignal());
    expect(initial).toEqual({ ...transcript(held), partial: true });
    if (!initial) throw new Error("Claude transcript preview did not load");

    await cancelPoll(reader, initial.turns, [replacement], timing);
    reader.setWorking(false);
    const next = await reader.callbacks().read(activeSignal());
    expect(next).toEqual(
      mode === "preview" ? { ...nextPreview, partial: true } : nextFull,
    );
  },
);

it("keeps the last accepted rows when valid overlap at the cancellation boundary is aborted after observation", async () => {
  const reader = openReader(true);
  const held = turn("accepted turn");
  const obsolete = turn("obsolete poll turn", 2);
  const fresh = turn("fresh working-change turn", 2);
  reader.preview.mockResolvedValue(undefined);
  reader.full.mockResolvedValue(transcript(held));
  reader.tail.mockResolvedValue([held, fresh]);
  const initial = await reader.callbacks().read(activeSignal());
  expect(initial).toEqual(transcript(held));
  if (!initial) throw new Error("Claude transcript did not load");

  await cancelPoll(reader, initial.turns, [held, obsolete], "after");
  reader.setWorking(false);
  await expect(reader.callbacks().read(activeSignal())).resolves.toEqual(
    transcript(held, fresh),
  );
});

it("keeps the baseline when an ordinary read starts preaborted", async () => {
  const reader = openReader(false);
  const held = turn("settled baseline");
  const appended = turn("appended turn", 2);
  reader.preview.mockResolvedValue(undefined);
  reader.full.mockResolvedValue(transcript(held));
  reader.tail.mockResolvedValue([held, appended]);
  await expect(reader.callbacks().read(activeSignal())).resolves.toEqual(
    transcript(held),
  );

  const reason = new Error("Read already superseded");
  await expect(reader.callbacks().read(AbortSignal.abort(reason))).rejects.toBe(
    reason,
  );

  reader.setWorking(true);
  await expect(reader.callbacks().read(activeSignal())).resolves.toEqual(
    transcript(held, appended),
  );
});

it("rejects a late ordinary read with its own abort reason", async () => {
  const reader = openReader(false);
  const latePreview = deferred<ClaudeTranscript>();
  const current = turn("current history");
  const appended = turn("appended to current history", 2);
  reader.preview
    .mockReturnValueOnce(latePreview.promise)
    .mockResolvedValue(undefined);
  reader.full.mockResolvedValue(transcript(current));
  reader.tail.mockResolvedValue([current, appended]);
  const controller = new AbortController();
  const reason = new Error("Read superseded in flight");
  const pending = reader.callbacks().read(controller.signal);
  const settlement = pending.catch((error: unknown) => error);
  expect(reader.preview).toHaveBeenCalledOnce();
  controller.abort(reason);
  try {
    await expect(reader.callbacks().read(activeSignal())).resolves.toEqual(
      transcript(current),
    );
  } finally {
    latePreview.resolve(transcript(turn("superseded preview")));
  }
  expect(await settlement).toBe(reason);

  reader.setWorking(true);
  await expect(reader.callbacks().read(activeSignal())).resolves.toEqual(
    transcript(current, appended),
  );
});
