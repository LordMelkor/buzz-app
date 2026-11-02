import { expect, it, vi, afterEach } from "vitest";
import { registerAttention } from "./attention-command";
import type { AttentionSource } from "./attention-sources";

afterEach(() => vi.useRealTimers());
type Input = Parameters<AttentionSource["run"]>[0];
function harness(connected = true, eof = false) {
  let ready!: () => void;
  const spawned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let run!: (input: Input) => Promise<void>;
  let output!: (text: string) => void;
  let exit!: (code: number) => void;
  const end = vi.fn(async () => {
    if (eof) exit(0);
  });
  const kill = vi.fn(async () => {
    exit(0);
  });
  const controller = new AbortController(),
    emit = vi.fn();
  const spawn = connected
    ? vi.fn(
        async (_id: string, options: { onStdout?: (data: string) => void }) => {
          output = options.onStdout ?? (() => {});
          controller.signal.addEventListener(
            "abort",
            () => {
              void kill();
            },
            { once: true },
          );
          ready();
          return {
            write: async () => {},
            end,
            kill,
            exited: new Promise<number>((resolve) => {
              exit = resolve;
            }),
          };
        },
      )
    : undefined;
  registerAttention({
    agents: {
      addAttentionSource: (source) => {
        if (source.id === "command") run = source.run;
      },
    },
  });
  return {
    run,
    spawn: spawn as Input["spawn"],
    spawned,
    controller,
    emit,
    kill,
    end,
    output: (text: string) => output(text),
    exit: (code: number) => exit(code),
  };
}

it("batches each burst, retries a refused queue, and drains the final output", async () => {
  vi.useFakeTimers();
  const h = harness();
  const done = h.run({
    spawn: h.spawn,
    id: "watch/test",
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "attention/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: h.controller.signal,
    emit: h.emit,
  });
  await Promise.resolve();
  h.output("first");
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.emit).toHaveBeenLastCalledWith("first");
  h.emit.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  h.output("second");
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.emit).toHaveBeenLastCalledWith("second");
  h.output("last");
  h.exit(0);
  await done;
  expect(h.emit).toHaveBeenLastCalledWith("last");
});
it("kills execution on cancellation and discards buffered output", async () => {
  const h = harness(true);
  const done = h.run({
    spawn: h.spawn,
    id: "watch/test",
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "attention/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: h.controller.signal,
    emit: h.emit,
  });
  await h.spawned;
  h.output("pending");
  h.controller.abort();
  await done;
  expect(h.kill).toHaveBeenCalledTimes(1);
  expect(h.emit).not.toHaveBeenCalled();
});

it("reports a process startup failure to the owning conversation", async () => {
  let run!: (input: Input) => Promise<void>;
  registerAttention({
    agents: {
      addAttentionSource: (source) => {
        if (source.id === "command") run = source.run;
      },
    },
  });
  const emit = vi.fn();
  await expect(
    run({
      spawn: async () => {
        throw new Error("program unavailable");
      },
      id: "watch/test",
      agent: "a",
      watch: {
        type: "source",
        interest_id: "test",
        enabled: true,
        provider: "attention/command",
        channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        config: { command: ["check"] },
      },
      signal: new AbortController().signal,
      emit,
    }),
  ).rejects.toThrow("program unavailable");
  expect(emit).toHaveBeenCalledWith(
    expect.stringContaining("program unavailable"),
  );
});

it.each(["command"])("uses only the run-bound launcher for %s", async (id) => {
  let run!: (input: Input) => Promise<void>;
  const agents = {
    addAttentionSource: (source: AttentionSource) => {
      if (source.id === id) run = source.run;
    },
  };
  const spawn = vi.fn(async function (this: unknown) {
    expect(this).toBeUndefined();
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
  registerAttention({ agents }, ["command"]);
  const signal = new AbortController().signal;
  const pr = "https://github.com/block/buzz-app/pull/1630";
  await run({
    spawn,
    id: "watch/test",
    agent: "agent",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: `attention/${id}`,
      channel: "channel",
      root: "root",
      config: { command: ["check"], pr, cwd: "/work" },
    },
    signal,
    emit: vi.fn(),
  });
  expect(spawn).toHaveBeenCalledWith("attention-command", {
    args: ["check"],
    cwd: "/work",
    onStdout: expect.any(Function),
    onStderr: expect.any(Function),
  });
});

it("refuses commands when the host has no agent launcher", async () => {
  const h = harness(false);
  await expect(
    h.run({
      spawn: h.spawn,
      id: "watch/test",
      agent: "agent",
      watch: {
        type: "source",
        interest_id: "test",
        enabled: true,
        provider: "attention/command",
        config: { command: ["check"] },
      },
      signal: h.controller.signal,
      emit: h.emit,
    }),
  ).rejects.toThrow("cannot run commands as the agent");
  expect(h.emit).not.toHaveBeenCalled();
});

function input(h: ReturnType<typeof harness>): Input {
  return {
    spawn: h.spawn,
    id: "watch/test",
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "attention/command",
      channel: "channel",
      config: { command: ["check"] },
    },
    signal: h.controller.signal,
    emit: h.emit,
  };
}
it("closes stdin so EOF-driven commands complete", async () => {
  const h = harness(true, true);
  const done = h.run(input(h));
  await h.spawned;
  await Promise.resolve();
  await Promise.resolve();
  expect(h.end).toHaveBeenCalledOnce();
  await done;
});
it("delivers an oversized burst without loss when the queue accepts it", async () => {
  const h = harness();
  const done = h.run(input(h));
  await h.spawned;
  const output = "a".repeat(40000) + "b".repeat(40000);
  h.output(output);
  h.exit(0);
  await done;
  expect(h.emit.mock.calls.map(([text]) => text).join("")).toBe(output);
});
it("marks omitted output when a refused queue exceeds the memory bound", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.emit.mockImplementation(() => {
    throw new Error("busy");
  });
  const done = h.run(input(h));
  await h.spawned;
  h.output("a".repeat(80000));
  await vi.advanceTimersByTimeAsync(1000);
  h.emit.mockImplementation(() => {});
  h.exit(0);
  await done;
  const delivered = h.emit.mock.calls.at(-1)?.[0];
  expect(delivered).toContain("14464 characters omitted");
  expect(delivered).toContain("a".repeat(65536));
});

it("drains a command that exits before stdin is closed", async () => {
  const h = harness();
  const done = h.run({
    ...input(h),
    spawn: async (_id, options) => {
      options?.onStdout?.("finished");
      return {
        write: async () => {},
        end: async () => {
          throw new Error("No such process");
        },
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    },
  });
  await done;
  expect(h.emit).toHaveBeenCalledWith("finished");
});

for (const prefix of [0, 65535]) {
  it(`preserves emoji across chunk boundaries with ${prefix} buffered characters`, async () => {
    const h = harness();
    const done = h.run(input(h));
    await h.spawned;
    if (prefix) h.output("a".repeat(prefix));
    const burst = "b".repeat(prefix ? 0 : 65535) + "🚀z";
    h.output(burst);
    h.exit(0);
    await done;
    const chunks = h.emit.mock.calls.map(([text]) => text as string);
    expect(chunks.join("")).toBe("a".repeat(prefix) + burst);
    for (const chunk of chunks)
      expect(chunk).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
  });
}
it("retains whole emoji when refused output trims the oldest characters", async () => {
  const h = harness();
  h.emit.mockImplementation(() => {
    throw new Error("busy");
  });
  const done = h.run(input(h));
  await h.spawned;
  h.output("a🚀" + "b".repeat(65535));
  h.emit.mockImplementation(() => {});
  h.exit(0);
  await done;
  expect(h.emit.mock.calls.at(-1)?.[0]).toBe(
    "[3 characters omitted while delivery was unavailable]\n" +
      "b".repeat(65535),
  );
});
