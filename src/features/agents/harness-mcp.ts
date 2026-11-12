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
/** undefined: the harness keeps its default. "none": no native server. */
export type HarnessMcpAnswer = HarnessMcpChoice | "none" | undefined;
/** For adapters, bundled or not, through the harness kit. */
export type HarnessMcpKit = Readonly<{
  choice(agent: Who): Promise<HarnessMcpAnswer>;
  /** After start and before the first prompt, with what the harness lists as
   * loaded. Throws when the choice is not in effect: stop the session. */
  started(agent: Who, session: string, loaded: HarnessMcpLoaded): void;
}>;

/** Where plugins stand on choosing: no plugin declares it, one that does is
 * still starting, one that does is not running, or its control is there. */
type Control = "absent" | "waiting" | "down" | "controlled";
/** A launch's choice: asked, then checked against what the harness loaded. */
type Launch = Readonly<{
  answer: HarnessMcpAnswer;
  phase: "asked" | "verified" | "refused";
  /** The protection a protected launch was asked under. */
  protection?: string;
}>;

export function createHarnessMcp(
  status: () => Context["pluginStatus"],
  running: (key: AgentKey) => Agent | undefined,
  types: () => readonly Pick<
    RegisteredAgentType,
    "key" | "harnessMcp" | "protectionUnavailable"
  >[],
) {
  let control: HarnessMcpControl | undefined;
  const launches = new Map<AgentKey, Launch>();
  const seen = new Map<string, readonly HarnessMcpTool[]>();
  const state = (): Control =>
    control
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
  async function answer(agent: Who): Promise<HarnessMcpAnswer> {
    if (agent.protection) return "none";
    if (state() === "waiting") await settle();
    switch (state()) {
      case "absent":
        return undefined;
      case "controlled": {
        const found = running(agent.key);
        try {
          return found && control ? control.choose(found) : "none";
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

  const kit: HarnessMcpKit = Object.freeze({
    async choice(agent) {
      const result = await answer(agent);
      launches.set(agent.key, {
        answer: result,
        phase: "asked",
        ...(agent.protection ? { protection: agent.protection.key } : {}),
      });
      return result;
    },
    started(agent, session, loaded) {
      const launch = launches.get(agent.key);
      if (!launch)
        throw new Error("The MCP choice was not asked for this agent");
      // A refused launch stays refused until the choice is asked again.
      if (launch.phase === "refused")
        throw new Error("This launch loaded MCP servers that were turned off");
      const choice = launch.answer;
      const extra = choice
        ? loaded.filter(({ name, tools }) => {
            const picked = choice === "none" ? false : choice[name];
            return (
              picked === false ||
              (Array.isArray(picked) &&
                tools?.some((tool) => picked.includes(tool)))
            );
          })
        : [];
      if (extra.length) {
        launches.set(agent.key, { ...launch, phase: "refused" });
        throw new Error(
          `Session ${session} loaded MCP servers that were turned off: ${extra.map(({ name }) => name).join(", ")}`,
        );
      }
      launches.set(agent.key, { ...launch, phase: "verified" });
    },
  });

  return {
    kit,
    /** Registers the one control, until the calling plugin's scope ends. */
    control(ctx: Context, next: HarnessMcpControl) {
      declared(ctx);
      if (control)
        throw new Error("A harness MCP control is already registered");
      ctx.effect(() => {
        control = next;
        return () => {
          if (control === next) control = undefined;
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
      const tools = await found.mcp.inspect(found.agent, server);
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
        const launch = launches.get(agent.key);
        if (
          launch?.phase !== "verified" ||
          launch.protection !== protection.key
        )
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
