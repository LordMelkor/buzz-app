// The MCP servers a harness loads by itself, and the one optional plugin
// (`host.agentMcp`) that may choose which of them an agent's sessions load.
// Core keeps the invariants: protected sessions load none, a control that
// fails means none, and each session proves the choice took effect. Calls
// are not core's: a plugin checks them through the harness's agent hooks.
import type { Context } from "@deepseek-ai/cordis";
import type { AgentProtection } from "../agent-protection/service";
import type { AgentKey } from "./membership";
import type { Agent, AgentHandle, RegisteredAgentType } from "./service";

/** One server's override. `false`: off. `true`: on. An object: on without
 * the `off` tools. `known` is every tool the control knows the server has,
 * for a harness that can only name the tools it allows. */
export type HarnessMcpServerChoice =
  | boolean
  | Readonly<{ off: readonly string[]; known: readonly string[] }>;
/** Overrides for one agent. A name it leaves out keeps the harness's default. */
export type HarnessMcpChoice = Readonly<Record<string, HarnessMcpServerChoice>>;
export type HarnessMcpTool = Readonly<{
  name: string;
  description?: string;
}>;
export type HarnessMcpServer = Readonly<{
  name: string;
  /** Whether this agent's sessions load it when no control chooses. */
  default: boolean;
  /** "disabled": turned off in the harness's own configuration. */
  state?: "connected" | "failed" | "needs-auth" | "disabled";
  /** Why the harness can't load it, in the harness's own words. */
  reason?: string;
}>;
export type HarnessMcpReport = Readonly<{
  /** Whether a choice may leave out single tools. */
  tools: boolean;
  /** Whether `inspectHarnessMcp` can list a server's tools. */
  inspect: boolean;
  /** The harness's agent hooks see this agent's native MCP calls before they
   * run, so a plugin's hook can stop one. Without it, a call the choice
   * allows runs unasked. */
  calls?: true;
  servers: readonly HarnessMcpServer[];
}>;
/** What a harness lists as loaded in a session. */
export type HarnessMcpLoaded = readonly Readonly<{
  name: string;
  state?: "connected" | "failed" | "needs-auth";
  tools?: readonly HarnessMcpTool[];
}>[];
export type HarnessMcpControl = Readonly<{
  choose(agent: Agent): HarnessMcpChoice | undefined;
  /** What a session of `agent` loaded, once it passed the check. Core keeps
   * none of it. */
  loaded?(agent: Agent, servers: HarnessMcpLoaded): void;
}>;

type Who = Pick<AgentHandle, "key" | "protection">;
/** A list of tool names, copied, or undefined. */
function names(value: unknown) {
  return Array.isArray(value) && value.every((tool) => typeof tool === "string")
    ? Object.freeze([...value])
    : undefined;
}
/** A control's answer as core uses it: an own-keys copy where a value that is
 * neither a boolean nor `{ off, known }` lists of tool names means off, and
 * anything but a plain object means none. Leaving every name out keeps every
 * default. */
function normalize(raw: unknown): HarnessMcpChoice | "none" {
  if (raw === undefined) return {};
  if (Object.prototype.toString.call(raw) !== "[object Object]") return "none";
  const choice: Record<string, HarnessMcpServerChoice> = Object.create(null);
  for (const [name, value] of Object.entries(raw as object)) {
    if (typeof value === "boolean") {
      choice[name] = value;
      continue;
    }
    const off = names((value as { off?: unknown } | null)?.off);
    const known = names((value as { known?: unknown } | null)?.known);
    choice[name] = off && known ? Object.freeze({ off, known }) : false;
  }
  return Object.freeze(choice);
}
/** undefined: the harness keeps its default. "none": no native server. */
export type HarnessMcpAnswer = HarnessMcpChoice | "none" | undefined;
/** For adapters, bundled or not, through the harness kit. */
export type HarnessMcpKit = Readonly<{
  choice(agent: Who): Promise<HarnessMcpAnswer>;
  /** After start and before the first prompt, with what the harness lists as
   * loaded and the answer `choice` gave this session. Throws when the choice
   * is not in effect: stop the session. Only the plugin that registered the
   * agent's type may call it, for an agent running here; the agent's
   * protection is read from what runs, not from `agent`. Tools carry their
   * descriptions and servers their state where the harness lists them: the
   * control's `loaded` gets the listing as given. */
  started(
    agent: Who,
    session: string,
    loaded: HarnessMcpLoaded,
    choice: HarnessMcpAnswer,
  ): void;
}>;

/** Where plugins stand on choosing: no plugin declares it, one that does is
 * still starting, one that does is not running, or its control is there. */
type Control = "absent" | "waiting" | "down" | "controlled";

export function createHarnessMcp(
  status: () => Context["pluginStatus"],
  running: (key: AgentKey) => Agent | undefined,
  types: () => readonly Pick<
    RegisteredAgentType,
    "key" | "pluginId" | "harnessMcp" | "protectionUnavailable"
  >[],
  /** The protection a running agent is launched under. */
  protectionOf: (agent: Agent) => AgentProtection | undefined,
) {
  /** The registered control, with the installation that registered it. */
  let control:
    | Readonly<{ value: HarnessMcpControl; id: string; revision: string }>
    | undefined;
  /** A protected agent's proof: the protection key under which a session
   * last showed nothing loaded. Absent: unproven, or a session since loaded
   * a server. Sessions starting meanwhile do not revoke it. */
  const proofs = new Map<AgentKey, string>();
  // A control answers only while its plugin is running, as contributions do.
  const state = (): Control =>
    control && status().isActive(control.id, control.revision)
      ? "controlled"
      : !status().unavailable?.("agentMcp")
        ? "absent"
        : (status().settled?.() ?? true)
          ? "down"
          : "waiting";
  const settle = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        if (state() !== "waiting") {
          off();
          resolve();
        }
      };
      const off = status().subscribe(done);
      done();
    });
  async function answer(agent: Agent): Promise<HarnessMcpAnswer> {
    if (agent.protection) return "none";
    if (state() === "waiting") await settle();
    switch (state()) {
      case "absent":
        return undefined;
      case "controlled": {
        try {
          return control ? normalize(control.value.choose(agent)) : "none";
        } catch {
          return "none";
        }
      }
      default:
        return "none";
    }
  }
  const typeOf = (agent: Pick<Agent, "type">) =>
    types().find((type) => type.key === agent.type);
  const declared = (ctx: Context) => {
    if (!ctx.pluginOwner?.agentMcp)
      throw new Error("Declare host.agentMcp access");
  };
  /** The agent and its type's hooks, when it runs here and its type reports. */
  function reporter(key: AgentKey) {
    const agent = running(key);
    const mcp = agent && typeOf(agent)?.harnessMcp;
    return agent && mcp && "report" in mcp ? { agent, mcp } : undefined;
  }

  /** The running agent `key` names, when the plugin `ctx` belongs to registered its type. */
  function owned(ctx: Context, key: AgentKey) {
    const agent = running(key);
    const type = agent && typeOf(agent);
    if (!agent || !type) throw new Error("This agent is not running here");
    if (type.pluginId !== ctx.pluginOwner?.id)
      throw new Error(
        "Only the plugin that runs this agent's harness uses its MCP kit",
      );
    return agent;
  }

  /** The kit for the plugin `ctx` belongs to. Only the plugin that registered
   * an agent's type asks its choice and reports its sessions, and the agent
   * and its protection are read from what runs here, not taken from the
   * caller. */
  const kitFor = (ctx: Context): HarnessMcpKit =>
    Object.freeze({
      async choice(who) {
        return answer(owned(ctx, who.key));
      },
      started(who, session, loaded, given) {
        started(owned(ctx, who.key), session, loaded, given);
      },
    });

  /** A session of `agent`, as it runs here, listed what it loaded. The proof
   * moves unproven -> proven(key) when a protected session loads nothing,
   * and back to unproven when any session loads a server it turned off. */
  function started(
    agent: Agent,
    session: string,
    loaded: HarnessMcpLoaded,
    given: HarnessMcpAnswer,
  ) {
    // A protection that can't be bound proves nothing, and still loads nothing.
    let protection: AgentProtection | undefined;
    try {
      protection = protectionOf(agent);
    } catch {
      protection = undefined;
    }
    // A protected session loads nothing, whatever the adapter applied.
    const choice = agent.protection ? "none" : given;
    const extra = choice
      ? loaded.filter(({ name, tools }) => {
          const picked =
            choice === "none"
              ? false
              : Object.hasOwn(choice, name)
                ? choice[name]
                : undefined;
          return (
            picked === false ||
            (typeof picked === "object" &&
              tools?.some((tool) => picked.off.includes(tool.name)))
          );
        })
      : [];
    if (extra.length) {
      proofs.delete(agent.key);
      throw new Error(
        `Session ${session} loaded MCP servers that were turned off: ${extra.map(({ name }) => name).join(", ")}`,
      );
    }
    if (protection) proofs.set(agent.key, protection.key);
    if (!agent.protection) tell(agent, loaded);
  }
  /** Gives the control what a session loaded, after the session goes on and
   * only while the control's plugin runs. Its throw or rejection is its own. */
  function tell(agent: Agent, loaded: HarnessMcpLoaded) {
    const entry = control;
    if (!entry?.value.loaded) return;
    void Promise.resolve()
      .then(() => {
        if (control === entry && state() === "controlled")
          return entry.value.loaded?.(agent, loaded);
      })
      .catch(() => undefined);
  }

  return {
    kitFor,
    /** Registers the one control, until the calling plugin's scope ends. */
    control(ctx: Context, next: HarnessMcpControl) {
      declared(ctx);
      const owner = ctx.pluginOwner;
      if (!owner) throw new Error("Declare host.agentMcp access");
      if (control)
        throw new Error("A harness MCP control is already registered");
      const entry = Object.freeze({
        value: next,
        id: owner.id,
        revision: owner.revision,
      });
      ctx.effect(() => {
        control = entry;
        return () => {
          if (control === entry) control = undefined;
        };
      });
    },
    async report(
      ctx: Context,
      key: AgentKey,
    ): Promise<HarnessMcpReport | undefined> {
      declared(ctx);
      const found = reporter(key);
      const report = found && (await found.mcp.report(found.agent));
      if (!found || !report) return undefined;
      const { calls, ...rest } = report;
      return {
        ...rest,
        ...(calls === true && !found.agent.protection && { calls }),
        inspect: !!found.mcp.inspect,
      };
    },
    /** Lists one server's tools in a session with no model turn. Core keeps
     * nothing; the caller does. */
    async inspect(ctx: Context, key: AgentKey, server: string) {
      declared(ctx);
      const found = reporter(key);
      if (!found?.mcp.inspect)
        throw new Error("This agent cannot list MCP tools");
      if (found.agent.protection)
        throw new Error("A protected agent loads no MCP server");
      const report = await found.mcp.report(found.agent);
      if (!report?.servers.some(({ name }) => name === server))
        throw new Error(`The harness has no MCP server named ${server}`);
      // The agent may have changed, or the plugin stopped, while it reported.
      const now = reporter(key);
      if (!now?.mcp.inspect || now.agent.protection)
        throw new Error("A protected agent loads no MCP server");
      const owner = ctx.pluginOwner;
      if (!owner || !status().isActive(owner.id, owner.revision))
        throw new Error("The plugin that asked is not running");
      return now.mcp.inspect(now.agent, server);
    },
    /** A protected agent of a type that reports its MCP servers passes no check
     * until a session of it has shown none loaded. The type's own
     * unavailability text says so, as for any protection it lacks. A type
     * with no MCP client has nothing to show. */
    require(
      protection: AgentProtection | undefined,
      agent: Pick<Agent, "key" | "type">,
    ): AgentProtection | undefined {
      const type = typeOf(agent);
      if (!protection || !type?.harnessMcp || !("report" in type.harnessMcp))
        return protection;
      const proven = () => {
        if (proofs.get(agent.key) !== protection.key)
          throw new Error(
            type.protectionUnavailable ??
              "This runtime has not shown that no MCP server loaded in the protected session",
          );
      };
      return {
        ...protection,
        check: async (action, signal) => {
          proven();
          return protection.check(action, signal);
        },
        checkEvidence: async (action, evidence, signal) => {
          proven();
          return protection.checkEvidence(action, evidence, signal);
        },
      };
    },
  };
}
