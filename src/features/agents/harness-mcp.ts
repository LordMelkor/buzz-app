// The MCP servers a harness loads by itself, and the one optional plugin
// (`host.agentMcp`) that may choose which of them an agent's sessions load.
// Core keeps the invariants: protected sessions load none, a control that
// fails means none, and each session proves the choice took effect.
import type { Context } from "@deepseek-ai/cordis";
import type { AgentProtection } from "../agent-protection/service";
import type { AgentKey } from "./membership";
import type { Agent, AgentHandle, RegisteredAgentType } from "./service";

/** Overrides for one agent. A name it leaves out keeps the harness's default.
 * `false`: off. `true`: on. A list: on without those tools. */
export type HarnessMcpChoice = Readonly<
  Record<string, boolean | readonly string[]>
>;
export type HarnessMcpTool = Readonly<{ name: string; description?: string }>;
export type HarnessMcpServer = Readonly<{
  name: string;
  /** Whether this agent's sessions load it when no control chooses. */
  default: boolean;
  /** "disabled": turned off in the harness's own configuration. */
  state?: "connected" | "failed" | "needs-auth" | "disabled";
  /** As last seen in this agent's sessions. */
  tools?: readonly HarnessMcpTool[];
}>;
export type HarnessMcpReport = Readonly<{
  /** Whether a choice may leave out single tools. */
  tools: boolean;
  /** Whether `inspectHarnessMcp` can list a server's tools. */
  inspect: boolean;
  /** Plain text from the adapter, shown as is: what this harness cannot guarantee. */
  note?: string;
  servers: readonly HarnessMcpServer[];
}>;
export type HarnessMcpControl = Readonly<{
  choose(agent: Agent): HarnessMcpChoice | undefined;
}>;
/** What a harness lists as loaded in a session. */
export type HarnessMcpLoaded = readonly Readonly<{
  name: string;
  tools?: readonly string[];
}>[];

type Who = Pick<AgentHandle, "key" | "protection">;
/** A control's answer as core uses it: an own-keys copy where a value that is
 * neither a boolean nor a list of tool names means off, and anything but a
 * plain object means none. Leaving every name out keeps every default. */
function normalize(raw: unknown): HarnessMcpChoice | "none" {
  if (raw === undefined) return {};
  if (Object.prototype.toString.call(raw) !== "[object Object]") return "none";
  const choice: Record<string, boolean | readonly string[]> =
    Object.create(null);
  for (const [name, value] of Object.entries(raw as object))
    choice[name] =
      typeof value === "boolean"
        ? value
        : Array.isArray(value) &&
            value.every((tool) => typeof tool === "string")
          ? Object.freeze([...value])
          : false;
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
   * protection is read from what runs, not from `agent`. */
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
  const seen = new Map<string, readonly HarnessMcpTool[]>();
  // A control answers only while its plugin is running, as contributions do.
  const state = (): Control =>
    control && status().isActive(control.id, control.revision)
      ? "controlled"
      : !status().agentMcpUnavailable?.()
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
  const slot = (key: AgentKey, server: string) => JSON.stringify([key, server]);
  /** The agent and its type's hooks, when it runs here and its type reports. */
  function reporter(key: AgentKey) {
    const agent = running(key);
    const mcp = agent && typeOf(agent)?.harnessMcp;
    return agent && mcp ? { agent, mcp } : undefined;
  }

  /** The kit for the plugin `ctx` belongs to. Only the plugin that registered
   * an agent's type says what its sessions loaded, and the agent and its
   * protection are read from what runs here, not taken from the caller. */
  /** The agent as it runs here, for the plugin that registered its type. */
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
  const kitFor = (ctx: Context): HarnessMcpKit =>
    Object.freeze({
      async choice(who) {
        return answer(owned(ctx, who.key));
      },
      started(who, session, loaded, given) {
        started(owned(ctx, who.key), session, loaded, given);
      },
    });
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
            (Array.isArray(picked) &&
              tools?.some((tool) => picked.includes(tool)))
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
      return (
        report && {
          ...report,
          inspect: !!found.mcp.inspect,
          servers: report.servers.map((server) => {
            const tools = server.tools ?? seen.get(slot(key, server.name));
            return tools ? { ...server, tools } : server;
          }),
        }
      );
    },
    /** Lists one server's tools in a session with no model turn, and keeps
     * them as that agent's last-seen tools for it. */
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
      const tools = await now.mcp.inspect(now.agent, server);
      seen.set(slot(key, server), tools);
      return tools;
    },
    /** A protected agent of a type that reports its MCP servers passes no check
     * until a session of it has shown none loaded. The type's own
     * unavailability text says so, as for any protection it lacks. */
    require(
      protection: AgentProtection | undefined,
      agent: Pick<Agent, "key" | "type">,
    ): AgentProtection | undefined {
      const type = typeOf(agent);
      if (!protection || !type?.harnessMcp) return protection;
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
