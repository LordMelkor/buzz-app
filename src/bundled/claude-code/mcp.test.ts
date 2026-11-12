// @vitest-environment node
import { expect, it, vi } from "vitest";
import { ClaudeProcess, type Spawn } from "./claude";
import { configuredMcp, type ClaudeMcp } from "./mcp";
import { fakeSpawn, flush } from "./claude-testing";
import { AgentSessions } from "./sessions";
import { ClaudeRuntime } from "./runtime";
import type {
  Agent,
  AgentHandle,
  Delivery,
} from "../../features/agents/service";
import { localStore } from "../../features/agents/state";

/** Fixed native protocol evidence, independent of the policy sent at launch. */
function native(
  servers = ["alpha"],
  admitted = ["read_echo"],
  catalog: Record<string, string[]> = {},
  context?: { name: string; serverName: string }[],
) {
  const fake = fakeSpawn();
  const spawn: Spawn = async (id, options) => {
    const process = await fake.spawn(id, options);
    const running = fake.processes.at(-1);
    return {
      ...process,
      write: async (data) => {
        const message = JSON.parse(data);
        const subtype = message.request?.subtype;
        if (subtype !== "mcp_status" && subtype !== "get_context_usage")
          return process.write(data);
        running?.received.push(message);
        running?.emit({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response:
              subtype === "mcp_status"
                ? {
                    mcpServers: servers.map((name) => ({
                      name,
                      status: "connected",
                      config: { env: { SECRET: "never report" } },
                      tools: (
                        catalog[name] ?? ["read_echo", "write_marker"]
                      ).map((name) => ({ name })),
                    })),
                  }
                : {
                    mcpTools:
                      context ??
                      admitted.map((name) => ({
                        serverName: "alpha",
                        name: `mcp__alpha__${name}`,
                      })),
                  },
          },
        });
      },
    };
  };
  return { ...fake, spawn };
}
const settings = (): ClaudeMcp => ({
  choice: { alpha: ["write_marker"], beta: false },
  servers: [
    { name: "alpha", default: true },
    { name: "beta", default: true },
  ],
  started: vi.fn(),
});

it("resolves preallowed child results by exact native tool identity despite overlapping server prefixes", async () => {
  const f = native(["alpha", "alpha__beta"], []);
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { ...settings(), ran },
  });
  const fake = f.processes[0];
  fake?.emit({
    type: "assistant",
    parent_tool_use_id: "parent",
    message: {
      content: [
        {
          type: "tool_use",
          id: "overlap",
          name: "mcp__alpha__beta__write_marker",
          input: {},
        },
      ],
    },
  });
  fake?.emit({
    type: "user",
    parent_tool_use_id: "parent",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "overlap", content: "written" },
      ],
    },
  });
  expect(ran).toHaveBeenCalledWith({
    session: "initial",
    id: "overlap",
    server: "alpha__beta",
    tool: "write_marker",
  });
  await process.kill();
});

it("uses an admitted tool's authoritative context server when catalog full names collide", async () => {
  const f = native(
    ["alpha", "alpha__beta"],
    [],
    { alpha: ["beta__read_echo"], alpha__beta: ["read_echo"] },
    [{ name: "mcp__alpha__beta__read_echo", serverName: "alpha__beta" }],
  );
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { ...settings(), ran },
  });
  f.processes[0]?.emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "context",
          name: "mcp__alpha__beta__read_echo",
          input: {},
        },
      ],
    },
  });
  f.processes[0]?.emit({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "context", content: "done" },
      ],
    },
  });
  expect(ran).toHaveBeenCalledWith({
    session: "initial",
    id: "context",
    server: "alpha__beta",
    tool: "read_echo",
  });
  await process.kill();
});

it("denies unresolved or ambiguous external callbacks and preserves authoritative native server metadata", async () => {
  const f = native(["alpha.beta", "alpha_beta"], []);
  const call = vi.fn(async (_call: unknown) => undefined);
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { ...settings(), call, ran },
  });
  const fake = f.processes[0];
  for (const [id, tool_name, mcp_server] of [
    ["unknown", "mcp__unknown__read", undefined],
    ["ambiguous", "mcp__alpha_beta__read_echo", undefined],
    ["malformed", "mcp__elsewhere__read", { name: "alpha.beta" }],
    ["wrong-sdk-identity", "mcp__alpha_beta__read_echo", { name: "buzz" }],
  ] as const)
    fake?.emit({
      type: "control_request",
      request_id: id,
      request: {
        subtype: "can_use_tool",
        tool_name,
        tool_use_id: id,
        ...(mcp_server ? { mcp_server } : {}),
        input: {},
      },
    });
  await flush();
  expect(call).not.toHaveBeenCalled();
  for (const id of ["unknown", "ambiguous", "malformed", "wrong-sdk-identity"])
    expect(
      fake?.received.find(
        (message) =>
          (message.response as { request_id?: string })?.request_id === id,
      ),
    ).toMatchObject({ response: { response: { behavior: "deny" } } });
  fake?.emit({
    type: "control_request",
    request_id: "identified",
    request: {
      subtype: "can_use_tool",
      tool_name: "mcp__alpha_beta__read_echo",
      tool_use_id: "identified",
      mcp_server: { name: "alpha.beta" },
      input: {},
    },
  });
  await flush();
  expect(call).toHaveBeenCalledWith(
    {
      session: "initial",
      id: "identified",
      server: "alpha.beta",
      tool: "read_echo",
      arguments: {},
    },
    expect.any(AbortSignal),
  );
  expect(
    fake?.received.find(
      (message) =>
        (message.response as { request_id?: string })?.request_id ===
        "identified",
    ),
  ).toMatchObject({ response: { response: { behavior: "allow" } } });
  fake?.emit({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "identified", content: "done" },
      ],
    },
  });
  expect(ran).toHaveBeenCalledWith({
    session: "initial",
    id: "identified",
    server: "alpha.beta",
    tool: "read_echo",
  });
  await process.kill();
});

it("stops unmatched observed executions rather than silently losing their backstop", async () => {
  const f = native();
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { ...settings(), ran },
  });
  f.processes[0]?.emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "unknown",
          name: "mcp__new_server__write_marker",
          input: {},
        },
      ],
    },
  });
  f.processes[0]?.emit({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "unknown", content: "done" },
      ],
    },
  });
  await process.exited;
  expect(f.processes[0]?.killed).toBe(true);
  expect(ran).not.toHaveBeenCalled();
});

it("keeps exact curated Buzz SDK tools outside the external gate", async () => {
  const f = native();
  const call = vi.fn(async (_call: unknown) => undefined);
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    tools: async (_session, message) => ({
      jsonrpc: "2.0",
      id: (message as { id: string }).id,
      result: { tools: [{ name: "send" }] },
    }),
    mcp: { ...settings(), call, ran },
  });
  const fake = f.processes[0];
  fake?.emit({
    type: "control_request",
    request_id: "sdk-list",
    request: {
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: "sdk-list", method: "tools/list" },
    },
  });
  await flush();
  fake?.emit({
    type: "control_request",
    request_id: "sdk-call",
    request: {
      subtype: "can_use_tool",
      tool_name: "mcp__buzz__send",
      tool_use_id: "sdk-call",
      input: {},
    },
  });
  fake?.emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "sdk-call",
          name: "mcp__buzz__send",
          input: {},
        },
      ],
    },
  });
  fake?.emit({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "sdk-call", content: "sent" },
      ],
    },
  });
  await flush();
  expect(call).not.toHaveBeenCalled();
  expect(ran).not.toHaveBeenCalled();
  expect(
    fake?.received.find(
      (message) =>
        (message.response as { request_id?: string })?.request_id ===
        "sdk-call",
    ),
  ).toMatchObject({ response: { response: { behavior: "allow" } } });
  expect(fake?.killed).toBe(false);
  await process.kill();
});

const agent = {
  key: "native-agent",
  pubkey: "a".repeat(64),
  relay: "wss://relay.example",
  config: { workspace: "/work" },
} as Agent;

it("keeps a session-only server and its last tools in the report after a later session turns it off", async () => {
  const names = ["alpha"];
  const f = native(names);
  const runtime = new ClaudeRuntime(
    { spawn: f.spawn, readFile: async () => new TextEncoder().encode("{}") },
    () => undefined,
    async () => undefined,
    localStore(),
  );
  let choice = {};
  runtime.mcp = {
    choice: async () => choice,
    started: () => {},
    call: async () => undefined,
    ran: () => false,
  };
  const delivery = {
    agent: { ...agent } as unknown as AgentHandle,
    config: agent.config,
  } as Delivery;
  try {
    await runtime.runOnce({
      delivery,
      key: "seen",
      signal: new AbortController().signal,
      prompt: async () => undefined,
    });
    names.length = 0;
    choice = { alpha: false };
    await runtime.runOnce({
      delivery,
      key: "off",
      signal: new AbortController().signal,
      prompt: async () => undefined,
    });
    expect(await runtime.harnessMcp(agent)).toMatchObject({
      calls: true,
      servers: [
        {
          name: "alpha",
          default: true,
          state: "connected",
          tools: [{ name: "read_echo" }, { name: "write_marker" }],
        },
      ],
    });
    expect(
      await runtime.harnessMcp({ ...agent, protection: {} } as Agent),
    ).not.toHaveProperty("calls");
    expect(
      f.processes.every((process) => process.killed && !process.prompts.length),
    ).toBe(true);
  } finally {
    runtime.dispose();
  }
});

it("keeps earlier inspected names when a later inspection lists only its selected server", async () => {
  const names = ["alpha"];
  const f = native(names);
  let definitions = { mcpServers: { alpha: {}, beta: {} } };
  const runtime = new ClaudeRuntime(
    {
      spawn: f.spawn,
      readFile: async (path) =>
        new TextEncoder().encode(
          JSON.stringify(path === "~/.claude.json" ? definitions : {}),
        ),
    },
    () => undefined,
    async () => undefined,
    localStore(),
  );
  try {
    await runtime.inspectMcp(agent, "alpha");
    names[0] = "beta";
    await runtime.inspectMcp(agent, "beta");
    definitions = { mcpServers: {} } as typeof definitions;
    expect(await runtime.harnessMcp(agent)).not.toHaveProperty("calls");
    expect(
      (await runtime.harnessMcp(agent))?.servers.map((server) => server.name),
    ).toEqual(["alpha", "beta"]);
    expect(
      f.processes.every((process) => process.killed && !process.prompts.length),
    ).toBe(true);
  } finally {
    runtime.dispose();
  }
});

it("reports the bounded native config union with native project approvals and metadata only", async () => {
  const files: Record<string, unknown> = {
    "~/.claude.json": {
      mcpServers: { user: { env: { SECRET: "hidden" } }, buzz: {} },
      projects: {
        "/work": {
          mcpServers: { local: {} },
          enabledMcpjsonServers: ["approved"],
          disabledMcpjsonServers: ["rejected"],
          disabledMcpServers: ["user"],
        },
        "/elsewhere": { mcpServers: { other: {} } },
      },
    },
    ".mcp.json": { mcpServers: { approved: {}, rejected: {}, unapproved: {} } },
  };
  const read = vi.fn(async (path: string, _options?: { cwd?: string }) =>
    new TextEncoder().encode(JSON.stringify(files[path] ?? {})),
  );
  const rows = await configuredMcp(read, "/work", [
    { name: "seen", default: true, tools: [{ name: "read" }] },
  ]);
  expect(rows).toEqual([
    { name: "seen", default: true, tools: [{ name: "read" }] },
    { name: "user", default: false, state: "disabled" },
    { name: "local", default: true },
    { name: "approved", default: true },
    { name: "rejected", default: false, state: "disabled" },
    { name: "unapproved", default: false, state: "disabled" },
  ]);
  expect(
    read.mock.calls.every(
      ([, options]) =>
        (options as { cwd?: string } | undefined)?.cwd === "/work",
    ),
  ).toBe(true);
});

it("honors enable-all without overriding an explicit project rejection", async () => {
  const files: Record<string, unknown> = {
    "~/.claude.json": {
      projects: { "/work": { disabledMcpjsonServers: ["off"] } },
    },
    ".mcp.json": { mcpServers: { on: {}, off: {} } },
    ".claude/settings.local.json": { enableAllProjectMcpServers: true },
  };
  expect(
    await configuredMcp(
      async (path) =>
        new TextEncoder().encode(JSON.stringify(files[path] ?? {})),
      "/work",
    ),
  ).toEqual([
    { name: "on", default: true },
    { name: "off", default: false, state: "disabled" },
  ]);
});

it("verifies admitted tools rather than the catalog and retains every configured applied choice", async () => {
  const f = native();
  const mcp = settings();
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp,
  });
  expect(mcp.started).toHaveBeenCalledWith(
    "initial",
    [{ name: "alpha", tools: ["read_echo"] }],
    { alpha: ["write_marker"], beta: false },
    [
      {
        name: "alpha",
        default: true,
        state: "connected",
        tools: [{ name: "read_echo" }, { name: "write_marker" }],
      },
    ],
  );
  const args = f.processes[0]?.options.args ?? [];
  expect(JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}")).toEqual({
    deniedMcpServers: [{ serverName: "beta" }],
    permissions: { ask: ["mcp__*"], deny: ["mcp__alpha__write_marker"] },
  });
  expect(f.processes[0]?.prompts).toEqual([]);
  await process.kill();
});

it("stops and awaits an inspection that reports another server before exposing tools", async () => {
  const f = native(["alpha", "unexpected"]);
  await expect(
    ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: { ...settings(), inspect: "alpha" },
    }),
  ).rejects.toThrow("unexpected MCP server");
  expect(f.processes[0]?.killed).toBe(true);
  expect(
    f.processes[0]?.received.some(
      (message) =>
        (message.request as { subtype?: string })?.subtype ===
        "get_context_usage",
    ),
  ).toBe(false);
  expect(f.processes[0]?.prompts).toEqual([]);
});

it("never prompts after core rejects readback, and strict-none keeps the SDK server out of the listing", async () => {
  const f = native();
  await expect(
    ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: {
        ...settings(),
        started: () => {
          throw new Error("choice did not apply");
        },
      },
    }),
  ).rejects.toThrow("choice did not apply");
  expect(f.processes[0]?.killed).toBe(true);
  expect(f.processes[0]?.prompts).toEqual([]);
  const empty = native(["buzz"], []);
  const started = vi.fn();
  const process = await ClaudeProcess.start(empty.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { choice: "none", servers: [], started },
  });
  expect(empty.processes[0]?.options.args).toContain("--strict-mcp-config");
  expect(started).toHaveBeenCalledWith("initial", [], "none", []);
  await process.kill();
});

it.each(["deny", "error", "abort"])(
  "keeps child MCP permission calls closed on %s while builtins retain bypass",
  async (mode) => {
    const f = native();
    let finish!: (reason: string | undefined) => void;
    const call = vi.fn((_call: unknown, _signal: AbortSignal) =>
      mode === "error"
        ? Promise.reject(new Error("failed"))
        : new Promise<string | undefined>((resolve) => {
            finish = resolve;
          }),
    );
    const process = await ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: { ...settings(), call },
    });
    const fake = f.processes[0];
    if (!fake) throw new Error("missing native process");
    fake.hold = true;
    const turn = process.send("fixture", { effort: "low" });
    await flush();
    expect(fake.prompts).toEqual(["fixture"]);
    fake.emit({
      type: "control_request",
      request_id: "child",
      request: {
        subtype: "can_use_tool",
        tool_name: "mcp__alpha__read_echo",
        tool_use_id: "child-call",
        agent_id: "child-agent",
        mcp_server: { name: "alpha" },
        input: { text: "fixture" },
      },
    });
    await flush();
    if (mode === "abort") await process.interrupt();
    if (mode !== "error") finish(mode === "deny" ? "denied" : undefined);
    await flush();
    expect(call.mock.calls[0]?.[0]).toEqual({
      session: "fresh",
      id: "child-call",
      server: "alpha",
      tool: "read_echo",
      arguments: { text: "fixture" },
    });
    expect(
      fake.received.find(
        (message) =>
          (message.response as { request_id?: string })?.request_id === "child",
      ),
    ).toMatchObject({ response: { response: { behavior: "deny" } } });
    fake.emit({
      type: "control_request",
      request_id: "builtin",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "true" },
      },
    });
    await flush();
    expect(
      fake.received.find(
        (message) =>
          (message.response as { request_id?: string })?.request_id ===
          "builtin",
      ),
    ).toMatchObject({ response: { response: { behavior: "allow" } } });
    expect(
      fake.received
        .filter(
          (message) =>
            (message.request as { subtype?: string })?.subtype ===
            "apply_flag_settings",
        )
        .at(-1),
    ).toMatchObject({
      request: {
        settings: {
          permissions: { ask: ["mcp__*"], deny: ["mcp__alpha__write_marker"] },
          effortLevel: "low",
        },
      },
    });
    fake.finish();
    await turn;
    await process.kill();
  },
);

it("correlates child results, skips explicit native unavailable-tool results, and reports other errors as ran", async () => {
  const f = native();
  const ran = vi.fn((_call: unknown) => false);
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: { ...settings(), ran },
  });
  const fake = f.processes[0];
  for (const [id, content, meta] of [
    [
      "unavailable",
      "<tool_use_error>Error: No such tool available: mcp__alpha__write_marker</tool_use_error>",
      undefined,
    ],
    ["denied", "Denied by native permission", { decision: "reject" }],
    ["failed", "Tool failed after writing", undefined],
  ] as const) {
    fake?.emit({
      type: "assistant",
      parent_tool_use_id: "parent-agent",
      agent_id: "child",
      message: {
        content: [
          { type: "tool_use", id, name: "mcp__alpha__write_marker", input: {} },
        ],
      },
    });
    fake?.emit({
      type: "user",
      parent_tool_use_id: "parent-agent",
      agent_id: "child",
      ...(meta
        ? { tool_result_meta: [{ id, permission_decision: meta }] }
        : {}),
      message: {
        content: [
          { type: "tool_result", tool_use_id: id, is_error: true, content },
        ],
      },
    });
  }
  expect(ran.mock.calls).toEqual([
    [
      {
        session: "initial",
        id: "denied",
        server: "alpha",
        tool: "write_marker",
        rejected: true,
      },
    ],
    [
      {
        session: "initial",
        id: "failed",
        server: "alpha",
        tool: "write_marker",
      },
    ],
  ]);
  await process.kill();
});

it("replaces idle sessions when the MCP choice changes and never borrows the spare", async () => {
  const f = native();
  let choice = "first";
  const take = vi.fn();
  const pool = new AgentSessions({
    spawn: f.spawn,
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    fingerprint: () => choice,
    spare: { take } as never,
    launch: async () => ({ cwd: "/work", systemPrompt: "", mcp: settings() }),
  });
  await pool.deliver("thread", "first", 1);
  choice = "second";
  await pool.deliver("thread", "second", 2);
  expect(take).not.toHaveBeenCalled();
  expect(
    f.processes
      .filter((process) => process.prompts.length)
      .map((process) => process.prompts),
  ).toEqual([["first"], ["second"]]);
  expect(f.processes[0]?.killed).toBe(true);
  await pool.shutdown();
});
