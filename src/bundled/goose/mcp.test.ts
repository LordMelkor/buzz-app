import { describe, expect, it, vi } from "vitest";
import type { HarnessMcpAnswer } from "../../features/agents/harness-mcp";
import type { Agent } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import { GooseProcess } from "./goose";
import { native, transport } from "./mcp-testing";
import { GooseMcp } from "./mcp";
import { GooseRuntime, DEFAULT_CONFIG } from "./runtime";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected the protocol fixture");
  return value;
}

async function setup(initial: HarnessMcpAnswer = { fixture: true }) {
  const wire = transport();
  let choice: HarnessMcpAnswer = initial;
  const kit = {
    choice: vi.fn(async () => choice),
    started: vi.fn(),
    call: vi.fn(async () => undefined as string | undefined),
    ran: vi.fn(() => false),
  };
  const who = { key: "agent@example.org" };
  const mcp = new GooseMcp(kit, () => who);
  const goose = await GooseProcess.start(wire.spawn, {
    cwd: "/work",
    serve: wire.fake.serve,
    mcp,
  });
  const open = () =>
    goose.open({ cwd: "/work", systemPrompt: "", tools: async () => ({}) });
  const finish = async (session: Awaited<ReturnType<typeof open>>) => {
    const done = session.send("Fixture turn");
    await vi.waitFor(() =>
      expect(wire.fake.geese[0]?.turns.at(-1)?.sessionId).toBe(session.id),
    );
    return { done };
  };
  return {
    ...wire,
    native: present(wire.fake.geese[0]),
    kit,
    who,
    goose,
    mcp,
    open,
    finish,
    choose: (next: HarnessMcpAnswer) => {
      choice = next;
    },
  };
}

const update = (
  id: string,
  toolName = "fixture__write_marker",
  extensionName: string | null = "fixture",
) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  rawInput: { fixture: true },
  _meta: {
    goose: { toolCall: { toolName, ...(extensionName && { extensionName }) } },
  },
});
const ask = (sessionId: string, id: string) => ({
  sessionId,
  toolCall: { toolCallId: id },
  options: [
    { kind: "allow_always", optionId: "always" },
    { kind: "allow_once", optionId: "once" },
    { kind: "reject_once", optionId: "reject" },
  ],
});

describe("Goose native MCP sessions", () => {
  it("keeps the no-control allowlist, auto mode and protocol unchanged", async () => {
    const t = await setup(undefined);
    t.choose(undefined); // setup's default argument is intentionally overridden.
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      present(t.native.turns[0]).finish();
      await done;
      const meta = present(t.native.opened[0])._meta as {
        enabledExtensions: { name?: string; server?: { name: string } }[];
      };
      expect(
        meta.enabledExtensions.map((e) => e.server?.name ?? e.name),
      ).toEqual(["developer", "buzz"]);
      expect(
        t.requests.some((r) =>
          /extensions|tools\/list|session\/set_mode/.test(r.method),
        ),
      ).toBe(false);
      expect(t.kit.started).not.toHaveBeenCalled();
      expect(t.native.env.GOOSE_MODE).toBe("auto");
    } finally {
      await t.goose.kill();
    }
  });

  it.each(["helper", "mesh"] as const)(
    "keeps no-control %s sessions on the original path",
    async (kind) => {
      const t = await setup();
      t.choose(undefined);
      try {
        const session = await t.goose.open({
          cwd: "/work",
          systemPrompt: "",
          ...(kind === "mesh" && { platform: [], tools: async () => ({}) }),
        });
        const { done } = await t.finish(session);
        expect(
          t.requests.some((r) =>
            /extensions|tools\/list|session\/set_mode/.test(r.method),
          ),
        ).toBe(false);
        expect(t.kit.started).not.toHaveBeenCalled();
        present(t.native.turns[0]).finish();
        await done;
      } finally {
        await t.goose.kill();
      }
    },
  );

  it("reports preallow only from native permission metadata", async () => {
    const t = await setup();
    try {
      t.permission("write_marker", "always_allow");
      t.permission("read_echo", "ask_before");
      const tools = await t.mcp.inspect(
        t.goose,
        "/work",
        "fixture",
        new AbortController().signal,
      );
      expect(tools).toEqual([
        { name: "read_echo", description: "read_echo" },
        { name: "write_marker", description: "write_marker", ungated: true },
      ]);
      expect((await t.mcp.report(t.goose)).servers[0]?.tools).toEqual(tools);
      t.permission("write_marker", null);
      expect(
        await t.mcp.inspect(
          t.goose,
          "/work",
          "fixture",
          new AbortController().signal,
        ),
      ).toEqual([
        { name: "read_echo", description: "read_echo" },
        { name: "write_marker", description: "write_marker" },
      ]);
    } finally {
      await t.goose.kill();
    }
  });

  it("carries preallow provenance from each session's own native readback", async () => {
    const t = await setup();
    try {
      t.permission("write_marker", "always_allow");
      const a = await t.open();
      const first = await t.finish(a);
      t.permission("write_marker", null);
      const b = await t.open();
      const second = await t.finish(b);
      // A later inspection can update the report, but cannot preallow B retroactively.
      t.permission("write_marker", "always_allow");
      await t.mcp.inspect(
        t.goose,
        "/work",
        "fixture",
        new AbortController().signal,
      );
      for (const [session, id] of [
        [a, "preallowed"],
        [b, "unknown"],
      ] as const) {
        t.native.update(session.id, update(id));
        t.native.update(session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
        });
      }
      await vi.waitFor(() => expect(t.kit.ran).toHaveBeenCalledTimes(2));
      expect(t.kit.ran).toHaveBeenNthCalledWith(1, t.who, {
        session: a.id,
        id: "preallowed",
        server: "fixture",
        tool: "write_marker",
        ungated: true,
      });
      expect(t.kit.ran).toHaveBeenNthCalledWith(2, t.who, {
        session: b.id,
        id: "unknown",
        server: "fixture",
        tool: "write_marker",
      });
      present(t.native.turns[0]).finish();
      present(t.native.turns[1]).finish();
      await first.done;
      await second.done;
    } finally {
      await t.goose.kill();
    }
  });

  it("reports metadata without a session or startup, and marks native disabled state", async () => {
    const t = await setup();
    try {
      expect(await t.mcp.report(t.goose)).toMatchObject({
        tools: true,
        servers: [
          { name: "fixture", default: false },
          { name: "other", default: false, state: "disabled" },
        ],
      });
      expect(JSON.stringify(await t.mcp.report(t.goose))).not.toMatch(
        /fixture-secret|private-config|TOKEN/,
      );
      expect(t.native.opened).toEqual([]);
    } finally {
      await t.goose.kill();
    }
  });

  it("reads controlled defaults back with an explicit false for every configured name before prompting", async () => {
    const t = await setup({});
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      expect(t.kit.started).toHaveBeenCalledWith(t.who, session.id, [], {
        fixture: false,
        other: false,
      });
      expect(
        t.requests.findIndex(
          (r) => r.method === "_goose/unstable/session/extensions/list",
        ),
      ).toBeLessThan(
        t.requests.findIndex((r) => r.method === "session/prompt"),
      );
      present(t.native.turns[0]).finish();
      await done;
    } finally {
      await t.goose.kill();
    }
  });

  it("updates one saved session's native tool filter and omits all-off extensions", async () => {
    const t = await setup();
    try {
      const session = await t.open();
      const first = await t.finish(session);
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [{ name: "fixture", tools: ["read_echo", "write_marker"] }],
        { fixture: true, other: false },
      );
      t.choose({ fixture: ["write_marker"] }); // The active turn keeps its selection.
      expect(
        t.requests.filter(
          (r) => r.method === "_goose/unstable/session/extensions/add",
        ),
      ).toHaveLength(1);
      present(t.native.turns.at(-1)).finish();
      await first.done;
      const second = session.send("Next turn");
      await vi.waitFor(() => expect(t.native.turns).toHaveLength(2));
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [{ name: "fixture", tools: ["read_echo"] }],
        { fixture: ["write_marker"], other: false },
      );
      present(t.native.turns.at(-1)).finish();
      await second;
      t.choose({ fixture: ["read_echo", "write_marker"] });
      const third = session.send("All off");
      await vi.waitFor(() => expect(t.native.turns).toHaveLength(3));
      expect(t.kit.started).toHaveBeenLastCalledWith(t.who, session.id, [], {
        fixture: ["read_echo", "write_marker"],
        other: false,
      });
      expect(
        t.requests
          .filter((r) => r.method.endsWith("extensions/add"))
          .some(
            (r) =>
              (
                r.params.extension as {
                  available_tools?: string[];
                  name?: string;
                  server?: { name: string };
                }
              ).available_tools?.length === 0,
          ),
      ).toBe(false);
      present(t.native.turns.at(-1)).finish();
      await third;
      expect(t.native.opened).toHaveLength(1);
      expect(t.requests.some((r) => r.method.includes("permissions/set"))).toBe(
        false,
      );
    } finally {
      await t.goose.kill();
    }
  });

  it("loads an empty denylist without needing a previously read catalog", async () => {
    const t = await setup({ fixture: [] });
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [{ name: "fixture", tools: ["read_echo", "write_marker"] }],
        { fixture: [], other: false },
      );
      present(t.native.turns[0]).finish();
      await done;
    } finally {
      await t.goose.kill();
    }
  });

  it("keeps admitted tool provenance local when other sessions and inspection change the report", async () => {
    const t = await setup();
    try {
      const a = await t.open();
      const first = await t.finish(a);
      t.choose({ fixture: ["write_marker"] });
      const b = await t.open();
      const second = await t.finish(b);
      t.native.update(a.id, update("executed-error"));
      t.native.update(a.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "executed-error",
        status: "failed",
        content: [{ text: "Fixture dependency not available" }],
      });
      await vi.waitFor(() => expect(t.kit.ran).toHaveBeenCalledOnce());
      expect(t.kit.ran).toHaveBeenLastCalledWith(t.who, {
        session: a.id,
        id: "executed-error",
        server: "fixture",
        tool: "write_marker",
      });
      // Inspection restores the shared last-seen catalog to all tools, while B still admits only reads.
      await t.mcp.inspect(
        t.goose,
        "/work",
        "fixture",
        new AbortController().signal,
      );
      t.native.update(b.id, update("unavailable"));
      t.native.update(b.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "unavailable",
        status: "failed",
        content: [{ text: "Tool 'fixture__write_marker' is not available." }],
      });
      present(t.native.turns[1]).finish();
      await second.done;
      expect(t.kit.ran).toHaveBeenCalledOnce();
      present(t.native.turns[0]).finish();
      await first.done;
    } finally {
      await t.goose.kill();
    }
  });

  it("does not prompt when readback is rejected or an abort follows the check", async () => {
    for (const abort of [false, true]) {
      const t = await setup();
      try {
        const session = await t.open();
        t.kit.started.mockImplementation(() => {
          if (abort) session.interrupt();
          else throw new Error("MCP mismatch");
        });
        const result = await session.send("Blocked");
        expect(t.native.turns).toHaveLength(0);
        expect(result.ok).toBe(false);
        expect(t.native.closed).toContain(session.id);
      } finally {
        await t.goose.kill();
      }
    }
  });

  it.each([undefined, "Denied", "Approval timed out"])(
    "answers native permission after gate returns %s",
    async (reason) => {
      const t = await setup();
      try {
        t.kit.call.mockResolvedValue(reason);
        const session = await t.open();
        const { done } = await t.finish(session);
        const native = t.native;
        native.update(session.id, update("call-1"));
        expect(
          (
            await native.ask(
              "session/request_permission",
              ask(session.id, "call-1"),
            )
          ).result,
        ).toEqual({
          outcome: {
            outcome: "selected",
            optionId: reason ? "reject" : "once",
          },
        });
        expect(t.kit.call).toHaveBeenCalledWith(
          t.who,
          {
            session: session.id,
            id: "call-1",
            server: "fixture",
            tool: "write_marker",
            arguments: { fixture: true },
          },
          expect.objectContaining({ hold: 120_000, signal: session.signal }),
        );
        native.update(session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: reason ? "failed" : "completed",
        });
        await vi.waitFor(() => expect(t.kit.ran).toHaveBeenCalled());
        expect(t.kit.ran).toHaveBeenCalledWith(t.who, {
          session: session.id,
          id: "call-1",
          server: "fixture",
          tool: "write_marker",
          ...(reason && { rejected: true }),
        });
        present(native.turns[0]).finish();
        await done;
      } finally {
        await t.goose.kill();
      }
    },
  );

  it("denies a held permission after abort, and autoallows curated calls without gating", async () => {
    const t = await setup();
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      const native = t.native;
      native.update(session.id, update("curated", "tree", null));
      expect(
        (
          await native.ask(
            "session/request_permission",
            ask(session.id, "curated"),
          )
        ).result,
      ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
      expect(t.kit.call).not.toHaveBeenCalled();
      let release!: () => void;
      t.kit.call.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      native.update(session.id, update("held"));
      const permission = native.ask(
        "session/request_permission",
        ask(session.id, "held"),
      );
      await vi.waitFor(() => expect(t.kit.call).toHaveBeenCalledOnce());
      session.interrupt();
      release();
      expect((await permission).result).toEqual({
        outcome: { outcome: "selected", optionId: "reject" },
      });
      await done;
    } finally {
      await t.goose.kill();
    }
  });

  it("does not report an unadvertised unavailable result as execution", async () => {
    const t = await setup();
    try {
      const session = await t.open();
      const first = await t.finish(session);
      present(t.native.turns[0]).finish();
      await first.done;
      t.choose({ fixture: ["write_marker"] });
      const next = session.send("Filtered turn");
      await vi.waitFor(() => expect(t.native.turns).toHaveLength(2));
      const native = t.native;
      native.update(session.id, update("filtered"));
      native.update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "filtered",
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Tool 'fixture__write_marker' is not available.",
            },
          },
        ],
      });
      present(native.turns[1]).finish();
      await next;
      expect(t.kit.call).not.toHaveBeenCalled();
      expect(t.kit.ran).not.toHaveBeenCalled();
    } finally {
      await t.goose.kill();
    }
  });

  it("checks preallowed native results, including real tool errors, and interrupts on violation", async () => {
    const t = await setup();
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      const native = t.native;
      native.update(session.id, update("real-error"));
      native.update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "real-error",
        status: "failed",
        content: [
          {
            text: "The user has declined to run this tool. DO NOT attempt to call this tool again. If there are no alternative methods to proceed, clearly explain the situation and STOP.",
          },
        ],
      });
      await vi.waitFor(() => expect(t.kit.ran).toHaveBeenCalled());
      expect(t.kit.ran).toHaveBeenLastCalledWith(t.who, {
        session: session.id,
        id: "real-error",
        server: "fixture",
        tool: "write_marker",
      });
      t.kit.ran.mockReturnValue(true);
      native.update(session.id, update("skipped-approval"));
      native.update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "skipped-approval",
        status: "completed",
      });
      await vi.waitFor(() => expect(native.cancelled).toContain(session.id));
      expect(t.kit.call).not.toHaveBeenCalled();
      await done;
    } finally {
      await t.goose.kill();
    }
  });
});

describe("Goose tools-only lifecycle", () => {
  it.each(["listed", "error", "cancelled"] as const)(
    "stops an isolated inspection after %s",
    async (outcome) => {
      const wire = transport();
      const kit = { choice: async () => undefined, started: vi.fn() };
      const host = {
        spawn: wire.spawn,
        resolveDirectory: wire.fake.resolveDirectory,
        readFile: vi.fn(),
        serveMcp: wire.fake.serve,
      } as unknown as Host;
      const storage = {
        getItem: () => null,
        setItem: () => {},
      } as unknown as Storage;
      const runtime = new GooseRuntime(
        host,
        () => undefined,
        async () => undefined,
        storage,
        () => [],
        () => "",
        undefined,
        kit,
      );
      const agent = {
        key: "agent@example.org",
        config: { ...DEFAULT_CONFIG, workspace: "/project/fixture" },
      } as Agent;
      let listed!: () => void;
      const started = new Promise<void>((resolve) => {
        listed = resolve;
      });
      if (outcome === "error") wire.failTools();
      if (outcome === "cancelled") wire.holdTools(listed);
      const inspect = runtime.inspectMcp(agent, "fixture");
      try {
        if (outcome === "cancelled") {
          await started;
          await runtime.retire(agent.key);
        }
        if (outcome === "listed")
          expect(await inspect).toEqual([
            { name: "read_echo", description: "read_echo" },
            { name: "write_marker", description: "write_marker" },
          ]);
        else await expect(inspect).rejects.toThrow();
        expect(present(wire.fake.geese[0]).killed).toBe(true);
        expect(present(wire.fake.geese[0]).turns).toHaveLength(0);
        expect(present(wire.fake.geese[0]).opened[0]).toMatchObject({
          cwd: "/project/fixture",
          mcpServers: [],
          _meta: { enabledExtensions: [native("fixture")] },
        });
      } finally {
        runtime.dispose();
      }
    },
  );
});
