import { expect, it, vi } from "vitest";
import { createSessions } from "./sessions";
import type { TerminalInputSource } from "./renderer";
import type { TerminalBridge } from "./bridge";
import type { ChannelPanelContext } from "../../features/panels/service";
import { nip19 } from "nostr-tools";

const context: ChannelPanelContext = {
  scope: `https://relay.example:${"ab".repeat(32)}`,
  viewer: "ab".repeat(32),
  channelId: "ea939ee7-0c17-41db-99e7-f672718682f6",
  channelName: "Terminal",
  relayUrl: "wss://relay.example",
  threadId: "cd".repeat(32),
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness() {
  let connection = {
    scope: context.scope,
    viewer: context.viewer,
    status: "ready",
  };
  const read = deferred<{ data: Uint8Array; exited: boolean }>();
  const bridge = {
    available: true as boolean,
    createOwner: vi.fn(async () => "owner"),
    spawn: vi.fn(async () => "pty"),
    read: vi.fn(() => read.promise),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeOwner: vi.fn(async () => {}),
  } satisfies TerminalBridge;
  const screen = {
    mount: vi.fn(() => () => {}),
    output: vi.fn(async (_: Uint8Array) => {}),
    dispose: vi.fn(),
  };
  let input!: (data: string, source: TerminalInputSource) => void;
  let resize!: (cols: number, rows: number) => void;
  const load = vi.fn(async () => (i: typeof input, r: typeof resize) => {
    input = i;
    resize = r;
    return screen;
  });
  const sessions = createSessions(bridge, load, () => connection);
  return {
    sessions,
    bridge,
    screen,
    read,
    load,
    input: (data: string, source: TerminalInputSource = "user") =>
      input(data, source),
    resize: (c: number, r: number) => resize(c, r),
    switchScope: () => {
      connection = { ...connection, scope: "other" };
    },
  };
}
it("spawns once with exact public context and retains the session across consumers", async () => {
  const h = harness();
  const first = h.sessions.ensure(context);
  const { threadId: _thread, ...withoutThread } = context;
  const second = h.sessions.ensure(withoutThread);
  expect(second).toBe(first);
  await tick();
  expect(h.bridge.spawn).toHaveBeenCalledExactlyOnceWith(
    "owner",
    {
      channelId: context.channelId,
      channelName: context.channelName,
      relayUrl: context.relayUrl,
      threadId: context.threadId,
      npub: nip19.npubEncode(context.viewer),
    },
    80,
    24,
  );
  h.input("echo hi\r");
  h.resize(10000, 10000);
  await tick();
  expect(h.bridge.write).toHaveBeenCalledWith("owner", "pty", "echo hi\r");
  expect(h.bridge.resize).toHaveBeenCalledWith("owner", "pty", 500, 300);
  h.read.resolve({ data: new Uint8Array([65, 66]), exited: true });
  await tick();
  expect(h.screen.output).toHaveBeenCalledWith(new Uint8Array([65, 66]));
  expect(h.bridge.close).toHaveBeenCalledExactlyOnceWith("owner", "pty");
  expect(h.sessions.get(context)?.status).toBe("exited");
  expect(h.sessions.ensure(context)).toBe(first); // No surprise respawn on reopen.
  await h.sessions.dispose();
  expect(h.bridge.closeOwner).toHaveBeenCalledWith("owner");
  expect(h.screen.dispose).toHaveBeenCalledOnce();
});
it("revokes a pending spawn and closes its late result", async () => {
  const h = harness();
  const spawn = deferred<string>();
  h.bridge.spawn.mockImplementation(() => spawn.promise);
  h.sessions.ensure(context);
  await tick();
  const ending = h.sessions.dispose();
  await tick();
  expect(h.bridge.closeOwner).toHaveBeenCalledWith("owner");
  spawn.resolve("late");
  await ending;
  expect(h.bridge.close).toHaveBeenCalledWith("owner", "late");
  expect(h.bridge.read).not.toHaveBeenCalled();
});
it("ending an in-flight session cannot attach its shell to the replacement", async () => {
  const h = harness();
  const spawn = deferred<string>();
  h.bridge.spawn.mockImplementationOnce(() => spawn.promise);
  h.sessions.ensure(context);
  await tick();
  await h.sessions.end(context);
  const replacement = h.sessions.ensure(context);
  await tick();
  spawn.resolve("retired");
  await tick();
  expect(h.bridge.close).toHaveBeenCalledWith("owner", "retired");
  expect(h.sessions.get(context)).toBe(replacement);
  h.read.resolve({ data: new Uint8Array(), exited: true });
  await tick();
  await h.sessions.dispose();
});
it("scope change during spawn closes the late shell instead of presenting it", async () => {
  const h = harness();
  const spawn = deferred<string>();
  h.bridge.spawn.mockImplementation(() => spawn.promise);
  h.sessions.ensure(context);
  await tick();
  h.switchScope();
  spawn.resolve("late");
  await tick();
  expect(h.bridge.close).toHaveBeenCalledWith("owner", "late");
  expect(h.sessions.get(context)?.status).toBe("ended");
  expect(h.bridge.read).not.toHaveBeenCalled();
  await h.sessions.dispose();
});
it("failed close remains retryable, and browser use never invokes native IPC", async () => {
  const h = harness();
  h.sessions.ensure(context);
  await tick();
  h.bridge.close.mockRejectedValueOnce(new Error("busy"));
  await expect(h.sessions.end(context)).rejects.toThrow("busy");
  expect(h.sessions.get(context)?.error).toContain("busy");
  await h.sessions.end(context);
  expect(h.sessions.get(context)).toBeUndefined();
  h.read.resolve({ data: new Uint8Array(), exited: false });
  await h.sessions.dispose();
  h.bridge.available = false;
  const browser = createSessions(h.bridge, h.load, () => ({
    status: "ready",
    scope: context.scope,
    viewer: context.viewer,
  }));
  const calls = h.bridge.createOwner.mock.calls.length;
  expect(browser.ensure(context)).toBeUndefined();
  expect(h.bridge.createOwner).toHaveBeenCalledTimes(calls);
  await browser.dispose();
});
it("a renderer error surfaces a restart path rather than respawning", async () => {
  const h = harness();
  h.load.mockRejectedValueOnce(new Error("renderer unavailable"));
  h.sessions.ensure(context);
  await tick();
  expect(h.sessions.get(context)?.status).toBe("error");
  expect(h.bridge.spawn).not.toHaveBeenCalled();
  h.sessions.ensure(context);
  expect(h.load).toHaveBeenCalledOnce();
  await h.sessions.dispose();
});

it("ending during final emulator output cannot resurrect status or close twice", async () => {
  const h = harness();
  const parsed = deferred<void>();
  const closed = deferred<void>();
  h.screen.output.mockImplementation(() => parsed.promise);
  h.bridge.close.mockImplementation(() => closed.promise);
  const entry = h.sessions.ensure(context);
  await tick();
  h.read.resolve({ data: new Uint8Array([65]), exited: true });
  await tick();
  const ending = h.sessions.end(context);
  await tick();
  parsed.resolve();
  await tick();
  expect(h.bridge.close).toHaveBeenCalledTimes(1);
  expect(entry?.status).toBe("ended");
  closed.resolve();
  await ending;
  await h.sessions.dispose();
});

it("scope switches fence both new and queued user input, but retain PTY replies", async () => {
  const h = harness();
  const writing = deferred<void>();
  h.bridge.write.mockImplementationOnce(() => writing.promise);
  h.sessions.ensure(context);
  await tick();
  h.input("first");
  await tick();
  h.input("queued user");
  h.input("queued reply", "reply");
  h.switchScope();
  h.input("stale user");
  h.input("background reply", "reply");
  writing.resolve();
  await tick();
  expect(h.bridge.write.mock.calls).toEqual([
    ["owner", "pty", "first"],
    ["owner", "pty", "queued reply"],
    ["owner", "pty", "background reply"],
  ]);
  h.read.resolve({ data: new Uint8Array(), exited: true });
  await tick();
  await h.sessions.dispose();
});

it.each(["end", "dispose"] as const)(
  "%s revokes queued and late replies as well as user input",
  async (operation) => {
    const h = harness();
    const writing = deferred<void>();
    h.bridge.write.mockImplementationOnce(() => writing.promise);
    h.sessions.ensure(context);
    await tick();
    h.input("first");
    await tick();
    h.input("queued user");
    h.input("queued reply", "reply");
    const ending =
      operation === "end" ? h.sessions.end(context) : h.sessions.dispose();
    h.input("late user");
    h.input("late reply", "reply");
    writing.resolve();
    h.read.resolve({ data: new Uint8Array(), exited: false });
    await ending;
    await tick();
    expect(h.bridge.write.mock.calls).toEqual([["owner", "pty", "first"]]);
    if (operation === "end") await h.sessions.dispose();
  },
);

it("restoring an ended panel waits for explicit start instead of spawning another shell", async () => {
  const h = harness();
  h.sessions.ensure(context, true);
  await vi.waitFor(() =>
    expect(h.sessions.get(context)?.status).toBe("running"),
  );
  await h.sessions.end(context);
  expect(h.sessions.ensure(context, true)).toBeUndefined();
  expect(h.sessions.get(context)).toBeUndefined();
  expect(h.bridge.spawn).toHaveBeenCalledTimes(1);
  h.sessions.ensure(context);
  await vi.waitFor(() => expect(h.bridge.spawn).toHaveBeenCalledTimes(2));
  h.read.resolve({ data: new Uint8Array(), exited: true });
  await h.sessions.dispose();
});

it("input wakes an idle read loop before the poll delay", async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    h.read.resolve({ data: new Uint8Array(), exited: false });
    h.sessions.ensure(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    h.input("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.write).toHaveBeenCalledWith("owner", "pty", "x");
    expect(h.bridge.read).toHaveBeenCalledTimes(2);
    // Without input, idle polling keeps its delay.
    await vi.advanceTimersByTimeAsync(39);
    expect(h.bridge.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bridge.read).toHaveBeenCalledTimes(3);
    const disposing = h.sessions.dispose();
    await vi.advanceTimersByTimeAsync(40);
    await disposing;
  } finally {
    vi.useRealTimers();
  }
});

it("input written during an in-flight read skips the following idle delay", async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const inFlight = deferred<{ data: Uint8Array; exited: boolean }>();
    h.bridge.read.mockImplementationOnce(() => inFlight.promise);
    h.read.resolve({ data: new Uint8Array(), exited: false });
    h.sessions.ensure(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    h.input("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.write).toHaveBeenCalledWith("owner", "pty", "x");
    // The read started before the write returns its earlier, empty result.
    inFlight.resolve({ data: new Uint8Array(), exited: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.read).toHaveBeenCalledTimes(2);
    const disposing = h.sessions.dispose();
    await vi.advanceTimersByTimeAsync(40);
    await disposing;
  } finally {
    vi.useRealTimers();
  }
});
