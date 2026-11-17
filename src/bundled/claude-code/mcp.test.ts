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
  beforeStatus?: () => Promise<void>,
  description?: string,
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
        if (subtype === "mcp_status") await beforeStatus?.();
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
                      ).map((name) => ({
                        name,
                        ...(description && { description }),
                      })),
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
  choice: {
    alpha: { off: ["write_marker"], known: ["read_echo", "write_marker"] },
    beta: false,
  },
  servers: [
    { name: "alpha", default: true },
    { name: "beta", default: true },
  ],
  started: vi.fn(),
});

it.each([
  {
    label: "dotted tool names",
    servers: ["alpha"],
    catalog: { alpha: ["search.docs"] },
    context: [{ name: "mcp__alpha__search_docs", serverName: "alpha" }],
    name: "mcp__alpha__search_docs",
    identity: { mcp_server: "alpha", mcp_tool: "search.docs" },
  },
  {
    label: "overlapping server prefixes",
    servers: ["alpha", "alpha__beta"],
    catalog: { alpha__beta: ["write.marker"] },
    context: [],
    name: "mcp__alpha__beta__write_marker",
    identity: { mcp_server: "alpha__beta", mcp_tool: "write.marker" },
  },
  {
    label: "authoritative admitted server amid catalog collisions",
    servers: ["alpha", "alpha__beta"],
    catalog: { alpha: ["beta__read_echo"], alpha__beta: ["read_echo"] },
    context: [
      { name: "mcp__alpha__beta__read_echo", serverName: "alpha__beta" },
    ],
    name: "mcp__alpha__beta__read_echo",
    identity: { mcp_server: "alpha__beta", mcp_tool: "read_echo" },
  },
])(
  "projects raw MCP identity to native hooks: $label",
  async ({ servers, catalog, context, name, identity }) => {
    const f = native(servers, [], catalog, context);
    const hook = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    }));
    const process = await ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: settings(),
      hook,
    });
    const fake = f.processes[0];
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      fake?.emit({
        type: "control_request",
        request_id: event,
        request: {
          subtype: "hook_callback",
          callback_id: `buzz:${event}`,
          input: {
            tool_name: name,
            tool_input: { text: "fixture" },
            mcp_server: "forged",
            mcp_tool: "forged",
          },
        },
      });
      await flush();
      expect(hook).toHaveBeenLastCalledWith(
        "",
        event,
        {
          tool_name: name,
          tool_input: { text: "fixture" },
          ...identity,
        },
        undefined,
      );
    }
    expect(fake?.received).toContainEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "PreToolUse",
        response: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
          },
        },
      },
    });
    await process.kill();
  },
);

it("refuses admitted tool names that collide after native normalization", async () => {
  const f = native(["alpha"], ["search_docs"], {
    alpha: ["search.docs", "search_docs"],
  });
  await expect(
    ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: settings(),
    }),
  ).rejects.toThrow("Claude could not verify an admitted MCP tool");
  expect(f.processes[0]?.killed).toBe(true);
  expect(f.processes[0]?.prompts).toEqual([]);
});

it.each([
  "mcp__unknown__read",
  "mcp__alpha_beta__read_echo",
  "mcp__buzz__send",
  "Bash",
])(
  "leaves unresolved, ambiguous and Buzz identities unnamed in hooks: %s",
  async (name) => {
    const f = native(
      ["alpha.beta", "alpha_beta", "buzz"],
      [],
      {
        "alpha.beta": ["read.echo"],
        alpha_beta: ["read_echo"],
        buzz: ["send"],
      },
      [],
    );
    const hook = vi.fn(async () => ({}));
    const process = await ClaudeProcess.start(f.spawn, {
      cwd: "/work",
      systemPrompt: "",
      mcp: settings(),
      hook,
    });
    const fake = f.processes[0];
    fake?.emit({
      type: "control_request",
      request_id: "hook",
      request: {
        subtype: "hook_callback",
        callback_id: "buzz:PreToolUse",
        input: { tool_name: name, mcp_server: "forged", mcp_tool: "forged" },
      },
    });
    await flush();
    expect(hook).toHaveBeenCalledWith(
      "",
      "PreToolUse",
      {
        tool_name: name,
        ...(name !== "mcp__buzz__send" && name !== "Bash"
          ? { mcp_unresolved: true }
          : {}),
      },
      undefined,
    );
    // Native hook policy belongs to plugins; an unresolved name does not kill the process.
    expect(fake?.killed).toBe(false);
    await process.kill();
  },
);

it("recognizes only SDK tools actually listed by the Buzz bridge without MCP control", async () => {
  const f = fakeSpawn();
  const hook = vi.fn(async () => ({}));
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    sessionId: "owned",
    hook,
    tools: async (_conversation, message) => ({
      jsonrpc: "2.0",
      id: (message as { id: number }).id,
      result: { tools: [{ name: "send" }] },
    }),
  });
  const fake = f.processes[0];
  fake?.emit({
    type: "control_request",
    request_id: "list",
    request: {
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    },
  });
  await flush();
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    for (const name of [
      "mcp__buzz__send",
      "mcp__buzz__unlisted",
      "mcp__unknown__tool",
    ]) {
      fake?.emit({
        type: "control_request",
        request_id: `${event}-${name}`,
        request: {
          subtype: "hook_callback",
          callback_id: `buzz:${event}`,
          input: {
            tool_name: name,
            mcp_server: "forged",
            mcp_tool: "forged",
            mcp_unresolved: false,
          },
        },
      });
      await flush();
      expect(hook).toHaveBeenLastCalledWith(
        "owned",
        event,
        {
          tool_name: name,
          ...(name !== "mcp__buzz__send" ? { mcp_unresolved: true } : {}),
        },
        undefined,
      );
    }
  }
  await process.kill();
});

const agent = {
  key: "native-agent",
  pubkey: "a".repeat(64),
  relay: "wss://relay.example",
  config: { workspace: "/work" },
} as Agent;

it("delivers live session inventory to the control without retaining it in static reports", async () => {
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
    started: vi.fn(),
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
    expect(runtime.mcp.started).toHaveBeenCalledWith(
      expect.objectContaining({ key: agent.key }),
      expect.any(String),
      [{ name: "alpha", state: "connected", tools: [{ name: "read_echo" }] }],
      { alpha: true },
    );
    expect(await runtime.harnessMcp(agent)).toMatchObject({
      calls: true,
      servers: [],
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

it("requires native project approval before inspection can start a process", async () => {
  const f = native();
  let approved = false;
  const runtime = new ClaudeRuntime(
    {
      spawn: f.spawn,
      readFile: async (path) =>
        new TextEncoder().encode(
          JSON.stringify(
            path === ".mcp.json"
              ? { mcpServers: { alpha: {} } }
              : path === "~/.claude.json" && approved
                ? {
                    projects: { "/work": { enabledMcpjsonServers: ["alpha"] } },
                  }
                : {},
          ),
        ),
    },
    () => undefined,
    async () => undefined,
  );
  try {
    await expect(runtime.inspectMcp(agent, "alpha")).rejects.toThrow(
      "Enable this MCP server in Claude before inspecting its tools",
    );
    expect(f.processes).toHaveLength(0);
    approved = true;
    expect(await runtime.inspectMcp(agent, "alpha")).toEqual([
      { name: "read_echo" },
      { name: "write_marker" },
    ]);
    expect(f.processes).toHaveLength(1);
    expect(f.processes[0]?.killed).toBe(true);
  } finally {
    await runtime.dispose();
  }
});

it("keeps earlier inspected names when a later inspection lists only its selected server", async () => {
  const names = ["alpha"];
  const context = [{ name: "mcp__alpha__read_echo", serverName: "alpha" }];
  const f = native(names, [], {}, context);
  let definitions = { mcpServers: { alpha: {}, beta: {}, buzz: {} } };
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
    const args = f.processes[0]?.options.args ?? [];
    expect(
      JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}"),
    ).toMatchObject({
      deniedMcpServers: [{ serverName: "beta" }, { serverName: "buzz" }],
    });
    names[0] = "beta";
    context[0] = { name: "mcp__beta__read_echo", serverName: "beta" };
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

it.each(["retire", "dispose"] as const)(
  "does not start an inspection after %s while its configuration is pending",
  async (stop) => {
    let read!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => {
      read = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = native();
    const runtime = new ClaudeRuntime(
      {
        spawn: f.spawn,
        readFile: async (path) => {
          if (path === "~/.claude.json") {
            read();
            await release;
          }
          return new TextEncoder().encode(
            JSON.stringify(
              path === "~/.claude.json" ? { mcpServers: { alpha: {} } } : {},
            ),
          );
        },
      },
      () => undefined,
      async () => undefined,
      localStore(),
    );
    const inspection = runtime.inspectMcp(agent, "alpha").then(
      (tools) => ({ tools }),
      (error) => ({ error }),
    );
    let stopping: Promise<unknown> | undefined;
    try {
      await reading;
      stopping =
        stop === "retire" ? runtime.retire(agent.key) : runtime.dispose();
      resume();
      await expect(inspection).resolves.toMatchObject({
        error: expect.objectContaining({
          message:
            stop === "retire" ? "Claude is retired" : "Claude was stopped",
        }),
      });
      await stopping;
      expect(f.processes).toHaveLength(0);
    } finally {
      resume();
      await inspection;
      await stopping;
      await runtime.dispose();
    }
  },
);

it("retires a live inspection only after its native process has exited", async () => {
  let read!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>((resolve) => {
    read = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = native(["alpha"], ["read_echo"], {}, undefined, async () => {
    read();
    await release;
  });
  const runtime = new ClaudeRuntime(
    {
      spawn: f.spawn,
      readFile: async (path) =>
        new TextEncoder().encode(
          JSON.stringify(
            path === "~/.claude.json" ? { mcpServers: { alpha: {} } } : {},
          ),
        ),
    },
    () => undefined,
    async () => undefined,
    localStore(),
  );
  const inspection = runtime.inspectMcp(agent, "alpha").catch((error) => error);
  let stopping: Promise<void> | undefined;
  let retired = false;
  try {
    await reading;
    const process = f.processes[0];
    if (!process) throw new Error("The inspection did not spawn");
    process.exitOnKill = false;
    stopping = runtime.retire(agent.key).then(() => {
      retired = true;
    });
    await vi.waitFor(() => expect(process.killed).toBe(true));
    expect(retired).toBe(false);
    resume();
    process.exit(0);
    await stopping;
    expect(retired).toBe(true);
  } finally {
    resume();
    f.processes[0]?.exit(0);
    await inspection;
    await stopping;
    await runtime.dispose();
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
  const rows = await configuredMcp(read, "/work");
  expect(rows).toEqual([
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
  const f = native(
    ["alpha"],
    ["read_echo"],
    {
      alpha: ["read_echo", "write.marker"],
    },
    undefined,
    undefined,
    "Native tool description",
  );
  const mcp = {
    ...settings(),
    choice: {
      alpha: { off: ["write.marker"], known: ["read_echo", "write.marker"] },
      beta: false,
    },
  };
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp,
  });
  expect(mcp.started).toHaveBeenCalledWith(
    "initial",
    [
      {
        name: "alpha",
        state: "connected",
        tools: [{ name: "read_echo", description: "Native tool description" }],
      },
    ],
    {
      alpha: { off: ["write.marker"], known: ["read_echo", "write.marker"] },
      beta: false,
    },
  );
  const args = f.processes[0]?.options.args ?? [];
  expect(JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}")).toEqual({
    deniedMcpServers: [{ serverName: "beta" }],
    permissions: { deny: ["mcp__alpha__write_marker"] },
  });
  expect(f.processes[0]?.prompts).toEqual([]);
  await process.kill();
});

it.each(["unexpected", "buzz"])(
  "stops and awaits an inspection that reports %s before exposing tools",
  async (unexpected) => {
    const f = native(["alpha", unexpected]);
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
  },
);

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
  expect(started).toHaveBeenCalledWith("initial", [], "none");
  await process.kill();
});

it("keeps ordinary permission fallback and tool exclusions without installing the old native gate", async () => {
  const f = native();
  const process = await ClaudeProcess.start(f.spawn, {
    cwd: "/work",
    systemPrompt: "",
    mcp: settings(),
  });
  const fake = f.processes[0];
  expect(fake?.options.args).not.toContain("--permission-prompt-tool");
  for (const name of ["Bash", "mcp__alpha__read_echo", "mcp__unknown__read"]) {
    fake?.emit({
      type: "control_request",
      request_id: name,
      request: {
        subtype: "can_use_tool",
        tool_name: name,
        input: { text: "fixture" },
      },
    });
    await flush();
    expect(fake?.received).toContainEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: name,
        response: { behavior: "allow", updatedInput: { text: "fixture" } },
      },
    });
  }
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
