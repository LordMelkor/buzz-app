import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import type { AgentProtection } from "../agent-protection/service";
import {
  createHarnessMcp,
  type HarnessMcpControl,
  type HarnessMcpReport,
} from "./harness-mcp";
import type { Agent } from "./service";

const key = "agent-key" as Agent["key"];
const agent = {
  key,
  type: "third/type",
  name: "Ampy",
  owner: "owner-key",
} as Agent;
const handle = { key } as never;

function setup(
  options: { harnessMcp?: unknown; protectionUnavailable?: string } = {},
) {
  const status = {
    unavailable: false,
    settled: true,
    active: true,
    listeners: new Set<() => void>(),
    change(
      next: Partial<{
        unavailable: boolean;
        settled: boolean;
        active: boolean;
      }>,
    ) {
      Object.assign(status, next);
      for (const listener of [...status.listeners]) listener();
    },
  };
  const root = new Context();
  /** What runs here: the agent, and the protection core binds for it. */
  const live: { agent: Agent; protection?: AgentProtection } = { agent };
  const created = createHarnessMcp(
    () =>
      ({
        isActive: (id: string, revision: string) =>
          status.active && id === "policy" && revision === "1",
        subscribe: (listener: () => void) => {
          status.listeners.add(listener);
          return () => status.listeners.delete(listener);
        },
        agentMcpUnavailable: () => status.unavailable,
        settled: () => status.settled,
      }) as never,
    (found) => (found === key ? live.agent : undefined),
    () => [
      {
        key: "third/type",
        pluginId: "third",
        ...(options.harnessMcp ? { harnessMcp: options.harnessMcp } : {}),
        ...(options.protectionUnavailable
          ? { protectionUnavailable: options.protectionUnavailable }
          : {}),
      } as never,
    ],
    () => live.protection,
  );
  /** A plugin's view of the kit; by default the plugin that registered the type. */
  const kitOf = (id = "third") =>
    created.kitFor(
      root.extend({ pluginOwner: { id, revision: "1" } } as never),
    );
  const mcp = { ...created, kit: kitOf() };
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
  return { mcp, status, scope, install, root, live, kitOf };
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

it("keeps only booleans and lists of tool names from a control's answer", async () => {
  const { mcp, install } = setup();
  const choose = vi.fn<HarnessMcpControl["choose"]>();
  await install({ choose });
  choose.mockReturnValue({
    alpha: true,
    beta: ["write"],
    gamma: "yes",
    delta: [1],
    constructor: true,
  } as never);
  const choice = await mcp.kit.choice(handle);
  expect({ ...(choice as object) }).toEqual({
    alpha: true,
    beta: ["write"],
    gamma: false,
    delta: false,
    constructor: true,
  });
  expect(Object.getPrototypeOf(choice)).toBeNull();
  for (const odd of ["all", ["alpha"], Promise.resolve({}), null]) {
    choose.mockReturnValue(odd as never);
    await expect(mcp.kit.choice(handle)).resolves.toBe("none");
  }
});

it("does not ask a control whose plugin is no longer running", async () => {
  const { mcp, install, status } = setup();
  const choose = vi.fn<HarnessMcpControl["choose"]>(() => ({ alpha: true }));
  await install({ choose });
  status.change({ active: false, unavailable: true });
  await expect(mcp.kit.choice(handle)).resolves.toBe("none");
  expect(choose).not.toHaveBeenCalled();
  status.change({ active: true, unavailable: false });
  await expect(mcp.kit.choice(handle)).resolves.toEqual({ alpha: true });
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
  // Leaving every name out keeps every default, and is still read back.
  choose.mockReturnValue(undefined);
  await expect(mcp.kit.choice(handle)).resolves.toEqual({});
  await expect(mcp.kit.choice({ key: "gone" } as never)).rejects.toThrow(
    "not running here",
  );
});

it("answers only the plugin that runs the agent, and loads nothing for a protected agent", async () => {
  const { mcp, install, live, kitOf } = setup();
  const choose = vi.fn(() => ({ alpha: true }));
  await install({ choose });
  await expect(kitOf("other").choice(handle)).rejects.toThrow(
    "Only the plugin that runs this agent's harness",
  );
  // Core reads protection from the agent as it runs, not from the caller.
  live.agent = { ...agent, protection: { provider: "p", policy: {} } } as Agent;
  await expect(mcp.kit.choice({ key } as never)).resolves.toBe("none");
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
  const { mcp, live } = setup({
    harnessMcp: { report: async () => undefined },
    protectionUnavailable: "No proof of unloaded MCP servers",
  });
  const base = protection();
  live.agent = { ...agent, protection: { provider: "p", policy: {} } } as Agent;
  live.protection = base;
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

it("takes what a session loaded only from the plugin that runs the agent's harness, for the agent as it runs", async () => {
  const { mcp, live, kitOf } = setup({
    harnessMcp: { report: async () => undefined },
    protectionUnavailable: "No proof of unloaded MCP servers",
  });
  const base = protection();
  live.agent = { ...agent, protection: { provider: "p", policy: {} } } as Agent;
  live.protection = base;
  const guarded = guard(mcp, base);
  const action = { kind: "context", session: "s", content: {} } as never;
  const signal = new AbortController().signal;
  // Another plugin can't prove an empty session for the agent.
  expect(() =>
    kitOf("other").started(
      { key, protection: base } as never,
      "s1",
      [],
      "none",
    ),
  ).toThrow("Only the plugin that runs this agent's harness");
  await expect(guarded.check(action, signal)).rejects.toThrow("No proof");
  // The protection is the one core bound for the running agent, not the caller's.
  expect(() =>
    mcp.kit.started(
      { key, protection: protection("forged") } as never,
      "s1",
      [],
      "none",
    ),
  ).not.toThrow();
  await guarded.check(action, signal);
  // Leaving protection out doesn't let a session of a protected agent load a server.
  expect(() =>
    mcp.kit.started({ key } as never, "s2", loaded("alpha"), { alpha: true }),
  ).toThrow(/alpha/);
  await expect(guarded.check(action, signal)).rejects.toThrow("No proof");
  // An agent that doesn't run here has no sessions to report.
  expect(() =>
    mcp.kit.started({ key: "gone" } as never, "s3", [], "none"),
  ).toThrow("not running here");
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

it("passes on calls only when the type says exactly true, and never for a protected agent", async () => {
  const said = { value: true as unknown };
  const { mcp, scope } = setup({
    harnessMcp: {
      report: async () => report({ calls: said.value, servers: [] } as never),
    },
  });
  expect(await mcp.report(scope(), key)).toMatchObject({ calls: true });
  said.value = "yes";
  expect(await mcp.report(scope(), key)).not.toHaveProperty("calls");
  said.value = true;
  const guarded = agent as { protection?: unknown };
  guarded.protection = { key: "p" };
  try {
    expect(await mcp.report(scope(), key)).not.toHaveProperty("calls");
  } finally {
    delete guarded.protection;
  }
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

it("keeps a tool's ungated flag only when it is exactly true", async () => {
  const listed = [
    { name: "a", ungated: true },
    { name: "b", ungated: "yes" },
    { name: "c", ungated: false, description: "Reads" },
    { name: "d" },
  ] as never;
  const { mcp, scope } = setup({
    harnessMcp: {
      report: async () =>
        report({
          servers: [
            { name: "alpha", default: false, tools: listed },
            { name: "beta", default: false },
          ],
        }),
      inspect: async () => listed,
    },
  });
  const expected = [
    { name: "a", ungated: true },
    { name: "b" },
    { name: "c", description: "Reads" },
    { name: "d" },
  ];
  const first = await mcp.report(scope(), key);
  expect(first?.servers[0]?.tools).toEqual(expected);
  await expect(mcp.inspect(scope(), key, "beta")).resolves.toEqual(expected);
  const after = await mcp.report(scope(), key);
  expect(after?.servers[1]?.tools).toEqual(expected);
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

it("checks again after the report, before a server starts", async () => {
  const inspect = vi.fn(async () => [{ name: "read" }]);
  let current: Agent = agent;
  const types = () => [
    {
      key: "third/type",
      harnessMcp: {
        report: async () => {
          // The agent turns protected while its type reports.
          current = {
            ...agent,
            protection: { provider: "p", policy: {} },
          } as Agent;
          return report();
        },
        inspect,
      },
    } as never,
  ];
  const mcp = createHarnessMcp(
    () => ({ isActive: () => true, subscribe: () => () => {} }) as never,
    () => current,
    types,
    () => undefined,
  );
  const { scope } = setup();
  await expect(mcp.inspect(scope(), key, "alpha")).rejects.toThrow("protected");
  const {
    mcp: stopped,
    scope: stoppedScope,
    status,
  } = setup({
    harnessMcp: { report: async () => report(), inspect },
  });
  status.change({ active: false });
  await expect(stopped.inspect(stoppedScope(), key, "alpha")).rejects.toThrow(
    "not running",
  );
  expect(inspect).not.toHaveBeenCalled();
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
    () => undefined,
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

describe("the call gate", () => {
  const owner = "owner-key";
  const options = (
    extra: Partial<{ hold: number; signal: AbortSignal }> = {},
  ) => ({
    hold: 1000,
    signal: new AbortController().signal,
    ...extra,
  });
  const call = (id = "c1", extra: object = {}) => ({
    session: "s1",
    id,
    server: "alpha",
    tool: "write",
    arguments: { path: "/tmp/x" },
    ...extra,
  });
  const mention = (pubkey: string) =>
    ({
      trigger: {
        type: "mention",
        event: { pubkey, tags: [["h", "chan"]] },
      },
    }) as never;
  /** A control installed, and a session started under `choice`. */
  async function gated(
    control: Partial<HarnessMcpControl> = {},
    choice: Record<string, boolean | string[]> = { alpha: true, beta: false },
    who: object = handle,
  ) {
    const made = setup();
    await made.install({ choose: () => undefined, ...control });
    made.mcp.kit.started(who as never, "s1", [], choice);
    return made;
  }
  const alpha = { alpha: true } as const;

  it("allows what an absent call hook does not stop, and leaves it to ran once", async () => {
    const { mcp } = await gated();
    await expect(
      mcp.kit.call(handle, call(), options()),
    ).resolves.toBeUndefined();
    // The harness shows it run: the allow is used up.
    expect(mcp.kit.ran(handle, call())).toBe(false);
    expect(mcp.kit.ran(handle, call())).toBe(true);
  });

  it("gives the call hook a copy of the arguments, so it can't change the call", async () => {
    const { mcp } = await gated({
      call: (each) => {
        (each.arguments as { path: string }).path = "/etc/passwd";
        return undefined;
      },
    });
    const given = call();
    await expect(
      mcp.kit.call(handle, given, options()),
    ).resolves.toBeUndefined();
    expect(given.arguments).toEqual({ path: "/tmp/x" });
  });

  it("denies a call whose turn already ended, even without a call hook, and records no allow", async () => {
    const { mcp } = await gated();
    const abort = new AbortController();
    abort.abort();
    await expect(
      mcp.kit.call(handle, call(), options({ signal: abort.signal })),
    ).resolves.toMatch(/turn ended/);
    expect(mcp.kit.ran(handle, call())).toBe(true);
  });

  it("lets a server the choice leaves out run where the session loaded it as the harness's default", async () => {
    const made = setup();
    await made.install({ choose: () => undefined });
    made.mcp.kit.started(
      handle as never,
      "s1",
      [{ name: "alpha" }, { name: "beta" }],
      { alpha: ["delete"] },
    );
    const { kit } = made.mcp;
    await expect(
      kit.call(handle, call("a", { server: "beta" }), options()),
    ).resolves.toBeUndefined();
    await expect(
      kit.call(handle, call("b", { server: "gamma" }), options()),
    ).resolves.toMatch(/turned off/);
    await expect(
      kit.call(handle, call("c", { tool: "delete" }), options()),
    ).resolves.toMatch(/turned off/);
  });

  it("denies a call of unknown tool when the server leaves any tool out", async () => {
    const { mcp } = await gated({}, { alpha: ["write"], gamma: [] });
    const { tool: _, ...unnamed } = call("u1");
    await expect(mcp.kit.call(handle, unnamed, options())).resolves.toMatch(
      /turned off/,
    );
    await expect(
      mcp.kit.call(
        handle,
        { ...unnamed, id: "u2", server: "gamma" },
        options(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      mcp.kit.call(handle, call("u3", { tool: "read" }), options()),
    ).resolves.toBeUndefined();
  });

  it("lets the harness's own always-allow run a tool the choice leaves on", async () => {
    const skipped = vi.fn();
    const { mcp } = await gated({ skipped }, { alpha: ["write"], beta: false });
    expect(
      mcp.kit.ran(handle, call("g1", { tool: "read", ungated: true })),
    ).toBe(false);
    expect(skipped).not.toHaveBeenCalled();
    // The choice still wins: a tool or server it turns off stops the turn.
    expect(mcp.kit.ran(handle, call("g2", { ungated: true }))).toBe(true);
    expect(
      mcp.kit.ran(handle, call("g3", { server: "beta", ungated: true })),
    ).toBe(true);
    expect(
      mcp.kit.ran(handle, call("g4", { session: "other", ungated: true })),
    ).toBe(true);
    expect(skipped).toHaveBeenCalledTimes(3);
  });

  it("tells the control what it needs, with direct only for the owner's own message", async () => {
    const asked = vi.fn<NonNullable<HarnessMcpControl["call"]>>(
      () => undefined,
    );
    const { mcp } = await gated({ call: asked });
    await mcp.kit.call(handle, call("c1"), {
      ...options(),
      turn: mention(owner),
    });
    await mcp.kit.call(handle, call("c2"), {
      ...options(),
      turn: mention("other"),
    });
    await mcp.kit.call(handle, call("c3"), options());
    expect(asked.mock.calls.map(([seen]) => seen.direct)).toEqual([
      true,
      false,
      false,
    ]);
    expect(asked.mock.calls[0]?.[0]).toEqual({
      agent: key,
      session: "s1",
      id: "c1",
      server: "alpha",
      tool: "write",
      arguments: { path: "/tmp/x" },
      hold: 1000,
      direct: true,
      conversation: { channel: "chan" },
    });
    expect(asked.mock.calls[2]?.[0]).not.toHaveProperty("conversation");
  });

  it("takes the conversation of a thread's message or a wake", async () => {
    const asked = vi.fn<NonNullable<HarnessMcpControl["call"]>>(
      () => undefined,
    );
    const { mcp } = await gated({ call: asked });
    const root = "e".repeat(64);
    await mcp.kit.call(handle, call("c1"), {
      ...options(),
      turn: {
        trigger: {
          type: "mention",
          event: {
            id: "m".repeat(64),
            pubkey: owner,
            tags: [
              ["h", "chan"],
              ["e", root, "", "reply"],
            ],
          },
        },
      } as never,
    });
    await mcp.kit.call(handle, call("c2"), {
      ...options(),
      turn: {
        trigger: {
          type: "plugin",
          plugin: "p",
          channel: "c2",
          root,
          text: "",
          id: "w",
          at: 1,
        },
      } as never,
    });
    expect(asked.mock.calls.map(([seen]) => seen.conversation)).toEqual([
      { channel: "chan", root, message: "m".repeat(64) },
      { channel: "c2", root },
    ]);
    expect(asked.mock.calls.map(([seen]) => seen.direct)).toEqual([
      true,
      false,
    ]);
  });

  it("denies in each place the choice, the session or the plugin does not allow it", async () => {
    const asked = vi.fn<NonNullable<HarnessMcpControl["call"]>>(
      () => undefined,
    );
    const { mcp, status } = await gated(
      { call: asked },
      { alpha: true, beta: false, gamma: ["write"] },
    );
    const deny = (extra: object, who: object = handle) =>
      mcp.kit.call(who as never, call("d", extra), options());
    await expect(deny({ server: "beta" })).resolves.toMatch(/beta/);
    await expect(deny({ server: "gamma" })).resolves.toMatch(/gamma\.write/);
    // A tool the list does not leave out goes on; one nobody could name does not.
    await expect(
      deny({ server: "gamma", tool: "read" }),
    ).resolves.toBeUndefined();
    await expect(deny({ server: "gamma", tool: undefined })).resolves.toMatch(
      /gamma is turned off/,
    );
    // A server the applied choice does not name, and one object property it inherits.
    await expect(deny({ server: "delta" })).resolves.toMatch(/delta/);
    await expect(deny({ server: "constructor" })).resolves.toMatch(
      /constructor/,
    );
    await expect(deny({ session: "other" })).resolves.toMatch(/no record/);
    await expect(deny({}, { key: "elsewhere" })).resolves.toMatch(/no record/);
    asked.mockClear();
    status.change({ active: false, unavailable: true });
    await expect(deny({})).resolves.toMatch(/not running/);
    expect(asked).not.toHaveBeenCalled();
  });

  it("denies when no control is registered, whatever the session recorded", async () => {
    const { mcp, install } = setup();
    const fiber = await install({ choose: () => undefined });
    mcp.kit.started(handle, "s1", [], alpha);
    await fiber.dispose();
    await expect(mcp.kit.call(handle, call(), options())).resolves.toMatch(
      /not running/,
    );
  });

  it("denies a protected agent without asking, and a none choice for any server", async () => {
    const asked = vi.fn<NonNullable<HarnessMcpControl["call"]>>(
      () => undefined,
    );
    const guarded = { key, protection: { key: "p" } } as never;
    const { mcp } = await gated({ call: asked }, alpha, guarded);
    await expect(mcp.kit.call(guarded, call(), options())).resolves.toMatch(
      /protected/,
    );
    const plain = await gated({ call: asked });
    plain.mcp.kit.started(handle, "s1", [], "none");
    await expect(
      plain.mcp.kit.call(handle, call(), options()),
    ).resolves.toMatch(/alpha/);
    expect(asked).not.toHaveBeenCalled();
  });

  it("takes a control's reason, and any answer that is not an allow, as a denial", async () => {
    const answers: unknown[] = [
      { deny: "Ask the owner first" },
      { deny: "" },
      { deny: 3 },
      null,
      "ok",
      false,
    ];
    let next = 0;
    const { mcp } = await gated({ call: () => answers[next++] as never });
    const reasons = [];
    for (const id of answers.keys())
      reasons.push(await mcp.kit.call(handle, call(`c${id}`), options()));
    expect(reasons[0]).toBe("Ask the owner first");
    expect(
      reasons.slice(1).every((reason) => typeof reason === "string" && reason),
    ).toBe(true);
    // None of them was allowed: each one that runs is reported.
    expect(mcp.kit.ran(handle, call("c0"))).toBe(true);
  });

  it("denies when the control throws or rejects", async () => {
    const control = vi.fn<NonNullable<HarnessMcpControl["call"]>>(() => {
      throw new Error("secret detail");
    });
    const { mcp } = await gated({ call: control });
    await expect(mcp.kit.call(handle, call("a"), options())).resolves.toBe(
      "The MCP call policy failed",
    );
    control.mockRejectedValue(new Error("secret detail"));
    await expect(mcp.kit.call(handle, call("b"), options())).resolves.toBe(
      "The MCP call policy failed",
    );
    expect(mcp.kit.ran(handle, call("a"))).toBe(true);
  });

  it("holds for the control's answer, then denies once the hold passes, ignoring a late allow", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (value: undefined) => void;
      const { mcp } = await gated({
        call: () => new Promise((resolve) => (answer = resolve)),
      });
      const asked = mcp.kit.call(handle, call(), options({ hold: 500 }));
      await vi.advanceTimersByTimeAsync(499);
      let settled = false;
      void asked.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(asked).resolves.toMatch(/did not answer in time/);
      answer(undefined);
      await vi.advanceTimersByTimeAsync(0);
      // The late allow did not take.
      expect(mcp.kit.ran(handle, call())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a call the control answers within its hold", async () => {
    const { mcp } = await gated({ call: async () => undefined });
    await expect(
      mcp.kit.call(handle, call(), options()),
    ).resolves.toBeUndefined();
  });

  it("denies when the turn's signal aborts, before or during the hold", async () => {
    const abort = new AbortController();
    const control = vi.fn<NonNullable<HarnessMcpControl["call"]>>(
      () => new Promise(() => {}),
    );
    const { mcp } = await gated({ call: control });
    const asked = mcp.kit.call(
      handle,
      call("a"),
      options({ signal: abort.signal, hold: 60_000 }),
    );
    abort.abort();
    await expect(asked).resolves.toMatch(/turn ended/);
    await expect(
      mcp.kit.call(
        handle,
        call("b"),
        options({ signal: abort.signal, hold: 60_000 }),
      ),
    ).resolves.toMatch(/turn ended/);
  });

  it("denies an allow that comes after the session started again or the plugin stopped", async () => {
    let answer!: (value: undefined) => void;
    const { mcp, status } = await gated({
      call: () => new Promise((resolve) => (answer = resolve)),
    });
    const first = mcp.kit.call(handle, call("a"), options());
    await Promise.resolve();
    mcp.kit.started(handle, "s1", [], alpha);
    answer(undefined);
    await expect(first).resolves.toMatch(/changed/);
    const second = mcp.kit.call(handle, call("b"), options());
    await Promise.resolve();
    status.change({ active: false, unavailable: true });
    answer(undefined);
    await expect(second).resolves.toMatch(/changed/);
    expect(mcp.kit.ran(handle, call("a"))).toBe(true);
  });

  it("never throws, whatever the call or options hold", async () => {
    const { mcp } = await gated();
    await expect(
      mcp.kit.call(handle, undefined as never, undefined as never),
    ).resolves.toEqual(expect.any(String));
  });

  it("tells the control about a call that ran with no allow, without its arguments", async () => {
    const skipped = vi.fn();
    const { mcp } = await gated({ skipped });
    expect(
      mcp.kit.ran(handle, {
        session: "s1",
        id: "x",
        server: "alpha",
        tool: "write",
        ...{ arguments: "hidden" },
      } as never),
    ).toBe(true);
    expect(skipped).toHaveBeenCalledWith({
      agent: key,
      session: "s1",
      id: "x",
      server: "alpha",
      tool: "write",
    });
    // A session nothing recorded fails closed the same way.
    expect(
      mcp.kit.ran(handle, { session: "none", id: "y", server: "alpha" }),
    ).toBe(true);
    expect(skipped).toHaveBeenLastCalledWith({
      agent: key,
      session: "none",
      id: "y",
      server: "alpha",
    });
  });

  it("does not count a call the harness blocked, and survives a control that fails to hear of one", async () => {
    const skipped = vi.fn(() => {
      throw new Error("boom");
    });
    const { mcp } = await gated({ skipped });
    expect(mcp.kit.ran(handle, { ...call(), rejected: true })).toBe(false);
    expect(skipped).not.toHaveBeenCalled();
    expect(mcp.kit.ran(handle, call())).toBe(true);
    skipped.mockRejectedValue(new Error("boom") as never);
    expect(mcp.kit.ran(handle, call())).toBe(true);
  });

  it("never tells the control about a protected agent's call", async () => {
    const skipped = vi.fn();
    const guarded = { key, protection: { key: "p" } } as never;
    const { mcp } = await gated({ skipped }, alpha, guarded);
    expect(mcp.kit.ran(guarded, call())).toBe(true);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("forgets a session whose start failed, and one that began with no choice", async () => {
    const { mcp } = await gated();
    expect(() =>
      mcp.kit.started(handle, "s1", loaded("beta"), { beta: false }),
    ).toThrow();
    await expect(mcp.kit.call(handle, call(), options())).resolves.toMatch(
      /no record/,
    );
    mcp.kit.started(handle, "s1", [], alpha);
    mcp.kit.started(handle, "s1", [], undefined);
    await expect(mcp.kit.call(handle, call(), options())).resolves.toMatch(
      /no record/,
    );
  });

  it("keeps a bounded number of sessions for each agent, oldest forgotten first", async () => {
    const { mcp } = await gated();
    for (let index = 0; index < 64; index++)
      mcp.kit.started(handle, `extra-${index}`, [], alpha);
    // s1 was the oldest of 65: forgotten, so denied and reported when it runs.
    await expect(mcp.kit.call(handle, call(), options())).resolves.toMatch(
      /no record/,
    );
    await expect(
      mcp.kit.call(handle, call("e", { session: "extra-63" }), options()),
    ).resolves.toBeUndefined();
    // Starting a session again keeps it newest.
    mcp.kit.started(handle, "extra-0", [], alpha);
    mcp.kit.started(handle, "fresh", [], alpha);
    await expect(
      mcp.kit.call(handle, call("f", { session: "extra-0" }), options()),
    ).resolves.toBeUndefined();
    await expect(
      mcp.kit.call(handle, call("g", { session: "extra-1" }), options()),
    ).resolves.toMatch(/no record/);
  });

  it("empties a session's allows when it starts again", async () => {
    const { mcp } = await gated();
    await mcp.kit.call(handle, call("a"), options());
    mcp.kit.started(handle, "s1", [], alpha);
    expect(mcp.kit.ran(handle, call("a"))).toBe(true);
  });
});
