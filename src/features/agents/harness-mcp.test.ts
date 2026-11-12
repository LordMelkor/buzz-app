import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import type { AgentProtection } from "../agent-protection/service";
import {
  createHarnessMcp,
  type HarnessMcpControl,
  type HarnessMcpReport,
} from "./harness-mcp";
import type { Agent } from "./service";

const key = "agent-key" as Agent["key"];
const agent = { key, type: "third/type", name: "Ampy" } as Agent;
const handle = { key } as never;

function setup(
  options: { harnessMcp?: unknown; protectionUnavailable?: string } = {},
) {
  const status = {
    unavailable: false,
    settled: true,
    listeners: new Set<() => void>(),
    change(next: Partial<{ unavailable: boolean; settled: boolean }>) {
      Object.assign(status, next);
      for (const listener of [...status.listeners]) listener();
    },
  };
  const root = new Context();
  const mcp = createHarnessMcp(
    () =>
      ({
        isActive: () => true,
        subscribe: (listener: () => void) => {
          status.listeners.add(listener);
          return () => status.listeners.delete(listener);
        },
        agentMcpUnavailable: () => status.unavailable,
        settled: () => status.settled,
      }) as never,
    (found) => (found === key ? agent : undefined),
    () => [
      {
        key: "third/type",
        ...(options.harnessMcp ? { harnessMcp: options.harnessMcp } : {}),
        ...(options.protectionUnavailable
          ? { protectionUnavailable: options.protectionUnavailable }
          : {}),
      } as never,
    ],
  );
  const scope = (agentMcp = true) =>
    root.extend({
      pluginOwner: {
        id: "policy",
        revision: "1",
        ...(agentMcp && { agentMcp }),
      },
    } as never);
  /** Registers `control` as an installed plugin does; disposing ends the scope. */
  async function install(control: HarnessMcpControl) {
    const fiber = scope().plugin((ctx) => mcp.control(ctx, control));
    await fiber.await();
    return fiber;
  }
  return { mcp, status, scope, install, root };
}

const loaded = (...names: string[]) => names.map((name) => ({ name }));

it("leaves the harness's default alone while no control or declaring plugin exists", async () => {
  const { mcp, status } = setup();
  // Owner decision: a launch is never delayed when no enabled plugin declares
  // the key, even while other plugins are still starting.
  status.settled = false;
  await expect(mcp.kit.choice(handle)).resolves.toBeUndefined();
  expect(() =>
    mcp.kit.started(handle, "s", loaded("anything"), undefined),
  ).not.toThrow();
});

it("asks the registered control, and an error from it loads nothing", async () => {
  const { mcp, install } = setup();
  const choose = vi.fn<HarnessMcpControl["choose"]>(() => ({ alpha: true }));
  await install({ choose });
  await expect(mcp.kit.choice(handle)).resolves.toEqual({ alpha: true });
  expect(choose).toHaveBeenCalledWith(agent);
  choose.mockImplementation(() => {
    throw new Error("control failed");
  });
  await expect(mcp.kit.choice(handle)).resolves.toBe("none");
  choose.mockReturnValue(undefined);
  await expect(mcp.kit.choice(handle)).resolves.toBeUndefined();
  await expect(mcp.kit.choice({ key: "gone" } as never)).resolves.toBe("none");
});

it("loads nothing for a protected agent and never asks the control", async () => {
  const { mcp, install } = setup();
  const choose = vi.fn(() => ({ alpha: true }));
  await install({ choose });
  await expect(
    mcp.kit.choice({ key, protection: { key: "p" } } as never),
  ).resolves.toBe("none");
  expect(choose).not.toHaveBeenCalled();
});

it("waits for a declaring plugin that is still starting, then loads nothing if it never runs", async () => {
  const { mcp, status } = setup();
  status.change({ unavailable: true, settled: false });
  let answer: unknown = "pending";
  const asked = mcp.kit.choice(handle).then((value) => (answer = value));
  await Promise.resolve();
  expect(answer).toBe("pending");
  status.change({ settled: true });
  await asked;
  expect(answer).toBe("none");
  // A plugin that failed earlier is already settled: no waiting.
  await expect(mcp.kit.choice(handle)).resolves.toBe("none");
});

it("uses the control of a declaring plugin that finishes starting while a launch waits", async () => {
  const { mcp, status, install } = setup();
  status.change({ unavailable: true, settled: false });
  const asked = mcp.kit.choice(handle);
  await install({ choose: () => ({ beta: false }) });
  status.change({ unavailable: false, settled: true });
  await expect(asked).resolves.toEqual({ beta: false });
});

it("rejects a server or tool the choice turned off when the harness lists it", async () => {
  const { mcp, install } = setup();
  await install({
    choose: () => ({ off: false, partial: ["write"], on: true }),
  });
  const choice = await mcp.kit.choice(handle);
  expect(() =>
    mcp.kit.started(
      handle,
      "s1",
      [
        { name: "on", tools: ["write"] },
        { name: "partial", tools: ["read"] },
      ],
      choice,
    ),
  ).not.toThrow();
  expect(() => mcp.kit.started(handle, "s2", loaded("off"), choice)).toThrow(
    /s2.*off/,
  );
  expect(() =>
    mcp.kit.started(
      handle,
      "s3",
      [{ name: "partial", tools: ["read", "write"] }],
      choice,
    ),
  ).toThrow(/partial/);
});

it("treats any listed server as a failure when nothing may load", async () => {
  const { mcp, status } = setup();
  status.change({ unavailable: true });
  const choice = await mcp.kit.choice(handle);
  expect(choice).toBe("none");
  expect(() => mcp.kit.started(handle, "s", [], choice)).not.toThrow();
  expect(() => mcp.kit.started(handle, "s", loaded("alpha"), choice)).toThrow(
    /alpha/,
  );
});

it("checks each session against the answer it was given, not a later one", async () => {
  const { mcp, install } = setup();
  let picked: Record<string, boolean> = { beta: true };
  await install({ choose: () => picked });
  const first = await mcp.kit.choice(handle);
  picked = { beta: false };
  const second = await mcp.kit.choice(handle);
  // The first session started with beta on; the newer answer does not judge it.
  expect(() =>
    mcp.kit.started(handle, "s1", loaded("beta"), first),
  ).not.toThrow();
  expect(() => mcp.kit.started(handle, "s2", loaded("beta"), second)).toThrow(
    /beta/,
  );
  // A name the choice does not own keeps the harness default.
  expect(() =>
    mcp.kit.started(handle, "s3", loaded("constructor"), second),
  ).not.toThrow();
});

it("takes one control, needs the manifest key, and drops it with the plugin's scope", async () => {
  const { mcp, scope, install, status, root } = setup();
  const first = await install({ choose: () => ({ a: true }) });
  await expect(
    root
      .extend({
        pluginOwner: { id: "other", revision: "1", agentMcp: true },
      } as never)
      .plugin((ctx) => mcp.control(ctx, { choose: () => undefined }))
      .await(),
  ).rejects.toThrow("already registered");
  expect(() => mcp.control(scope(false), { choose: () => undefined })).toThrow(
    "Declare host.agentMcp",
  );
  await expect(mcp.kit.choice(handle)).resolves.toEqual({ a: true });
  await first.dispose();
  await expect(mcp.kit.choice(handle)).resolves.toBeUndefined();
  // The same slot can be taken again once the scope has ended.
  await install({ choose: () => ({ b: true }) });
  await expect(mcp.kit.choice(handle)).resolves.toEqual({ b: true });
  // A declaring plugin that is no longer running fails closed again.
  status.change({ unavailable: true });
  await expect(mcp.kit.choice(handle)).resolves.toEqual({ b: true });
});

/** The protection as core hands it to a runtime. */
const guard = (
  mcp: ReturnType<typeof setup>["mcp"],
  base: AgentProtection,
): AgentProtection => {
  const guarded = mcp.require(base, agent);
  if (!guarded) throw new Error("No protection");
  return guarded;
};
const protection = (name = "p1") =>
  ({
    key: name,
    check: vi.fn(async () => undefined),
    checkEvidence: vi.fn(async () => undefined),
  }) as unknown as AgentProtection & {
    check: ReturnType<typeof vi.fn>;
    checkEvidence: ReturnType<typeof vi.fn>;
  };

it("refuses a protected agent's checks until a session has shown no MCP server loaded", async () => {
  const { mcp } = setup({
    harnessMcp: { report: async () => undefined },
    protectionUnavailable: "No proof of unloaded MCP servers",
  });
  const base = protection();
  const guarded = guard(mcp, base);
  const action = { kind: "context", session: "s", content: {} } as never;
  const evidence = {} as never;
  const signal = new AbortController().signal;
  const bound = { key, protection: base } as never;
  // unproven
  await expect(mcp.kit.choice(bound)).resolves.toBe("none");
  await expect(guarded.check(action, signal)).rejects.toThrow(
    "No proof of unloaded MCP servers",
  );
  await expect(guarded.checkEvidence(action, evidence, signal)).rejects.toThrow(
    "No proof",
  );
  expect(base.check).not.toHaveBeenCalled();
  // a listed server is no proof
  expect(() => mcp.kit.started(bound, "s1", loaded("alpha"), "none")).toThrow();
  await expect(guarded.check(action, signal)).rejects.toThrow("No proof");
  // proven: an empty listing opens the checks
  mcp.kit.started(bound, "s1", [], "none");
  await guarded.check(action, signal);
  await guarded.checkEvidence(action, evidence, signal);
  expect(base.check).toHaveBeenCalledTimes(1);
  expect(base.checkEvidence).toHaveBeenCalledTimes(1);
  // another session starting does not interrupt a proven one
  await mcp.kit.choice(bound);
  await guarded.check(action, signal);
  // any session that loads a server revokes the proof, whatever was passed
  expect(() =>
    mcp.kit.started(bound, "s2", loaded("alpha"), undefined),
  ).toThrow(/alpha/);
  await expect(guarded.check(action, signal)).rejects.toThrow("No proof");
  // a proof belongs to the protection it was given under
  mcp.kit.started(bound, "s3", [], "none");
  await guarded.check(action, signal);
  const replaced = guard(mcp, protection("p2"));
  await expect(replaced.check(action, signal)).rejects.toThrow("No proof");
});

it("leaves protection alone for a type that does not report MCP servers", () => {
  const { mcp } = setup();
  const base = protection();
  expect(mcp.require(base, agent)).toBe(base);
  expect(mcp.require(undefined, agent)).toBeUndefined();
});

const report = (overrides: Partial<HarnessMcpReport> = {}) => ({
  tools: true,
  servers: [
    { name: "alpha", default: false },
    { name: "beta", default: false },
  ],
  ...overrides,
});

it("reports a type's servers only to a plugin with the manifest key, with last-seen tools", async () => {
  const inspect = vi.fn(async () => [{ name: "read", description: "Reads" }]);
  const { mcp, scope } = setup({
    harnessMcp: {
      report: async () =>
        report({
          servers: [
            { name: "alpha", default: false },
            { name: "beta", default: false, tools: [{ name: "own" }] },
          ],
        }),
      inspect,
    },
  });
  await expect(mcp.report(scope(false), key)).rejects.toThrow(
    "Declare host.agentMcp",
  );
  const before = await mcp.report(scope(), key);
  expect(before).toMatchObject({ inspect: true, tools: true });
  expect(before?.servers[0]).toEqual({ name: "alpha", default: false });
  await mcp.inspect(scope(), key, "alpha");
  await mcp.inspect(scope(), key, "beta");
  const after = await mcp.report(scope(), key);
  expect(after?.servers).toEqual([
    {
      name: "alpha",
      default: false,
      tools: [{ name: "read", description: "Reads" }],
    },
    { name: "beta", default: false, tools: [{ name: "own" }] },
  ]);
  await expect(
    mcp.report(scope(), "unknown" as never),
  ).resolves.toBeUndefined();
});

it("lists a type's tools only for a known server of an unprotected agent", async () => {
  const inspect = vi.fn(async () => [{ name: "read" }]);
  const { mcp, scope } = setup({
    harnessMcp: { report: async () => report(), inspect },
  });
  await expect(mcp.inspect(scope(false), key, "alpha")).rejects.toThrow(
    "Declare host.agentMcp",
  );
  await expect(mcp.inspect(scope(), key, "missing")).rejects.toThrow(/missing/);
  expect(inspect).not.toHaveBeenCalled();
  await expect(mcp.inspect(scope(), key, "alpha")).resolves.toEqual([
    { name: "read" },
  ]);
  expect(inspect).toHaveBeenCalledWith(agent, "alpha");
  inspect.mockRejectedValueOnce(new Error("did not connect"));
  await expect(mcp.inspect(scope(), key, "beta")).rejects.toThrow(
    "did not connect",
  );
  // A failed listing keeps nothing; the earlier one stays.
  const after = await mcp.report(scope(), key);
  expect(after?.servers.map(({ tools }) => tools?.length)).toEqual([
    1,
    undefined,
  ]);
});

it("never lists tools for a protected agent or a type that cannot", async () => {
  const protectedAgent = {
    ...agent,
    protection: { provider: "p", policy: {} },
  };
  const inspect = vi.fn(async () => []);
  const { mcp, scope } = setup({
    harnessMcp: { report: async () => report(), inspect },
  });
  const guarded = createHarnessMcp(
    () => ({ isActive: () => true, subscribe: () => () => {} }) as never,
    () => protectedAgent as never,
    () => [
      {
        key: "third/type",
        harnessMcp: { report: async () => report(), inspect },
      } as never,
    ],
  );
  await expect(guarded.inspect(scope(), key, "alpha")).rejects.toThrow(
    "protected",
  );
  expect(inspect).not.toHaveBeenCalled();
  const plain = setup({ harnessMcp: { report: async () => report() } });
  await expect(plain.mcp.inspect(plain.scope(), key, "alpha")).rejects.toThrow(
    "cannot list",
  );
  expect((await mcp.report(scope(), key))?.inspect).toBe(true);
});
