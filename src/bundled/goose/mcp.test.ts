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

describe("Goose native MCP sessions", () => {
  it("keeps the no-control allowlist, auto mode and protocol unchanged", async () => {
    const t = await setup(undefined);
    t.choose(undefined); // setup's default argument is intentionally overridden.
    t.saved("fixture", {
      envs: { TOKEN: "fixture-secret" },
      cwd: "/private-config",
    });
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
      expect(
        t.requests.some(
          (r) =>
            r.method === "_goose/unstable/config/read" &&
            r.params.key === "extensions",
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

  it("keeps the tool catalog independent of native approval preferences", async () => {
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
        { name: "write_marker", description: "write_marker" },
      ]);
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
      expect(await t.mcp.report(t.goose)).not.toHaveProperty("calls");
      expect(t.native.opened).toEqual([]);
    } finally {
      await t.goose.kill();
    }
  });

  it.each([{}, { summon: true, delegate: true }])(
    "keeps controlled defaults off and cannot select platform delegation with %j",
    async (choice) => {
      const t = await setup(choice);
      try {
        expect(
          (await t.mcp.report(t.goose)).servers.map((s) => s.name),
        ).toEqual(["fixture", "other"]);
        const session = await t.open();
        const { done } = await t.finish(session);
        const meta = present(t.native.opened[0])._meta as {
          enabledExtensions: { name?: string; server?: { name: string } }[];
        };
        expect(
          meta.enabledExtensions.map((e) => e.server?.name ?? e.name),
        ).toEqual(["developer", "buzz"]);
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
    },
  );

  it.each([
    { envs: { TOKEN: "fixture-secret" } },
    { cwd: "/private-config" },
    { env: { TOKEN: "fixture-secret" } },
  ])("refuses lossy native launches and inspection with %j", async (saved) => {
    const t = await setup();
    try {
      t.saved("fixture", { name: undefined, ...saved });
      const report = await t.mcp.report(t.goose);
      expect(report.servers.find((s) => s.name === "fixture")).toMatchObject({
        default: false,
        state: "failed",
      });
      const reason = report.servers.find((s) => s.name === "fixture")?.reason;
      expect(reason).toMatch(/fixture.*can't start|can't start.*fixture/);
      expect(reason).toContain("carry over");
      expect(reason).toContain(
        "cwd" in saved ? "working directory" : "environment values",
      );
      expect(JSON.stringify(report)).not.toMatch(
        /fixture-secret|private-config|TOKEN/,
      );
      await expect(
        t.mcp.inspect(
          t.goose,
          "/work",
          "fixture",
          new AbortController().signal,
        ),
      ).rejects.toThrow(/carry over/);
      await expect(t.open()).rejects.toThrow(/carry over/);
      expect(t.native.opened).toEqual([]);
      expect(t.requests.some((r) => r.method.endsWith("extensions/add"))).toBe(
        false,
      );
    } finally {
      await t.goose.kill();
    }
  });

  it("keeps a lossy server Off while selecting another server, and refuses a later lossy change", async () => {
    const t = await setup({ fixture: false, other: true });
    try {
      t.saved("fixture", {
        envs: { TOKEN: "fixture-secret" },
        cwd: "/private-config",
      });
      const session = await t.open();
      const first = await t.finish(session);
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [
          {
            name: "other",
            state: "connected",
            tools: [
              { name: "read_echo", description: "read_echo" },
              { name: "write_marker", description: "write_marker" },
            ],
          },
        ],
        { fixture: false, other: true },
      );
      present(t.native.turns[0]).finish();
      await first.done;
      t.choose({ fixture: true, other: true });
      const additions = t.requests.filter((r) =>
        r.method.endsWith("extensions/add"),
      ).length;
      let settled = false;
      const next = session.send("Turn on the lossy server").finally(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(settled || t.native.turns.length === 2).toBe(true),
      );
      t.native.turns[1]?.finish();
      expect((await next).ok).toBe(false);
      expect(t.native.turns).toHaveLength(1);
      expect(
        t.requests.filter((r) => r.method.endsWith("extensions/add")),
      ).toHaveLength(additions);
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
        [
          {
            name: "fixture",
            state: "connected",
            tools: [
              { name: "read_echo", description: "read_echo" },
              { name: "write_marker", description: "write_marker" },
            ],
          },
        ],
        { fixture: true, other: false },
      );
      t.choose({
        fixture: {
          off: ["write_marker"],
          known: ["read_echo", "write_marker"],
        },
      }); // The active turn keeps its selection.
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
        [
          {
            name: "fixture",
            state: "connected",
            tools: [{ name: "read_echo", description: "read_echo" }],
          },
        ],
        {
          fixture: {
            off: ["write_marker"],
            known: ["read_echo", "write_marker"],
          },
          other: false,
        },
      );
      present(t.native.turns.at(-1)).finish();
      await second;
      t.choose({
        fixture: {
          off: ["read_echo", "write_marker"],
          known: ["read_echo", "write_marker"],
        },
      });
      const third = session.send("All off");
      await vi.waitFor(() => expect(t.native.turns).toHaveLength(3));
      expect(t.kit.started).toHaveBeenLastCalledWith(t.who, session.id, [], {
        fixture: {
          off: ["read_echo", "write_marker"],
          known: ["read_echo", "write_marker"],
        },
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

  it("loads a supplied catalog with no excluded tools before any inspection", async () => {
    const t = await setup({
      fixture: { off: [], known: ["read_echo", "write_marker"] },
    });
    try {
      const session = await t.open();
      const { done } = await t.finish(session);
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [
          {
            name: "fixture",
            state: "connected",
            tools: [
              { name: "read_echo", description: "read_echo" },
              { name: "write_marker", description: "write_marker" },
            ],
          },
        ],
        {
          fixture: { off: [], known: ["read_echo", "write_marker"] },
          other: false,
        },
      );
      present(t.native.turns[0]).finish();
      await done;
    } finally {
      await t.goose.kill();
    }
  });

  it("keeps the allowed tools on a fresh adapter after a saved tool exclusion", async () => {
    const t = await setup({
      fixture: { off: ["write_marker"], known: ["read_echo", "write_marker"] },
    });
    try {
      // No report, inspection or earlier session warms the adapter's inventory.
      const session = await t.open();
      const { done } = await t.finish(session);
      const meta = present(t.native.opened[0])._meta as {
        enabledExtensions: {
          server?: { name: string };
          available_tools?: string[];
        }[];
      };
      expect(
        meta.enabledExtensions.find((e) => e.server?.name === "fixture"),
      ).toMatchObject({ available_tools: ["read_echo"] });
      expect(t.kit.started).toHaveBeenLastCalledWith(
        t.who,
        session.id,
        [
          {
            name: "fixture",
            state: "connected",
            tools: [{ name: "read_echo", description: "read_echo" }],
          },
        ],
        {
          fixture: {
            off: ["write_marker"],
            known: ["read_echo", "write_marker"],
          },
          other: false,
        },
      );
      expect(t.requests.some((r) => r.method === "session/set_mode")).toBe(
        false,
      );
      present(t.native.turns[0]).finish();
      await done;
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
});

function inspector(wire: ReturnType<typeof transport>, spawn = wire.spawn) {
  const kit = { choice: async () => undefined, started: vi.fn() };
  const host = {
    spawn,
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
    undefined,
    kit,
  );
  const agent = {
    key: "agent@example.org",
    config: { ...DEFAULT_CONFIG, workspace: "/project/fixture" },
  } as Agent;
  return { runtime, agent };
}

describe("Goose tools-only lifecycle", () => {
  it.each(["listed", "error", "cancelled"] as const)(
    "stops an isolated inspection after %s",
    async (outcome) => {
      const wire = transport();
      const { runtime, agent } = inspector(wire);
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
  it.each(["spawn", "tools"] as const)(
    "waits for a cancelled inspection's actual exit during retirement (%s)",
    async (stage) => {
      vi.useFakeTimers();
      const wire = transport();
      let requested!: () => void;
      const stopped = new Promise<void>((resolve) => {
        requested = resolve;
      });
      let spawned!: () => void;
      const spawning = new Promise<void>((resolve) => {
        spawned = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let listed!: () => void;
      const listing = new Promise<void>((resolve) => {
        listed = resolve;
      });
      wire.holdTools(listed);
      const { runtime, agent } = inspector(wire, async (id, options) => {
        const process = await wire.spawn(id, options);
        spawned();
        if (stage === "spawn") await held;
        return {
          ...process,
          kill: async () => {
            requested();
          },
        };
      });
      let retiring: Promise<void> | undefined;
      const inspection = runtime.inspectMcp(agent, "fixture");
      const rejected = inspection.then(
        () => undefined,
        (error: unknown) => error,
      );
      let retired = false;
      try {
        await (stage === "spawn" ? spawning : listing);
        retiring = runtime.retire(agent.key).then(() => {
          retired = true;
        });
        // Passing the old stop timeout is not evidence that the process exited.
        await vi.advanceTimersByTimeAsync(6_000);
        expect(retired).toBe(false);
        release();
        await stopped;
        await vi.advanceTimersByTimeAsync(0);
        expect(retired).toBe(false);
        present(wire.fake.geese[0]).exit(null);
        expect(await rejected).toBeInstanceOf(Error);
        await retiring;
        expect(retired).toBe(true);
      } finally {
        release();
        wire.fake.geese[0]?.exit(null);
        await inspection.catch(() => undefined);
        await retiring;
        runtime.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("retains a failed inspection cleanup for retirement to retry", async () => {
    const wire = transport();
    let fail = true;
    const kill = vi.fn(async () => {
      if (fail) throw new Error("Native stop failed");
      present(wire.fake.geese[0]).exit(null);
    });
    const { runtime, agent } = inspector(wire, async (id, options) => ({
      ...(await wire.spawn(id, options)),
      kill,
    }));
    try {
      await expect(runtime.inspectMcp(agent, "fixture")).rejects.toThrow(
        "Native stop failed",
      );
      await expect(runtime.retire(agent.key)).rejects.toThrow(
        "Native stop failed",
      );
      fail = false;
      await runtime.retire(agent.key);
      expect(kill).toHaveBeenCalledTimes(3);
    } finally {
      wire.fake.geese[0]?.exit(null);
      runtime.dispose();
    }
  });
});
