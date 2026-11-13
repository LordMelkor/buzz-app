// The MCP servers a harness loads by itself, and the one optional plugin
// (`host.agentMcp`) that may choose which of them an agent's sessions load.
// Core keeps the invariants: protected sessions load none, a control that
// fails means none, and each session proves the choice took effect.
import type { Context } from "@deepseek-ai/cordis";
import type { AgentProtection } from "../agent-protection/service";
import { threadReference } from "../relay/thread-reference";
import type { AgentKey } from "./membership";
import type {
  Agent,
  AgentHandle,
  Delivery,
  RegisteredAgentType,
  Trigger,
} from "./service";

/** Overrides for one agent. A name it leaves out keeps the harness's default.
 * `false`: off. `true`: on. A list: on without those tools. */
export type HarnessMcpChoice = Readonly<
  Record<string, boolean | readonly string[]>
>;
export type HarnessMcpTool = Readonly<{
  name: string;
  description?: string;
  /** The harness's own setting runs this tool without asking, so `call` never
   * sees it; only `ran` reports it afterward. Set only when the adapter can
   * read that setting. */
  ungated?: true;
}>;
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
  /** The harness puts this agent's native MCP calls to the control's `call`
   * before they run. Without it no call can be held: a call the choice allows
   * runs unasked, and `ran` stops the turn. */
  calls?: true;
  /** Plain text from the adapter, shown as is: what this harness cannot guarantee. */
  note?: string;
  servers: readonly HarnessMcpServer[];
}>;
/** A native MCP call, as the adapter sees the harness make it. */
export type HarnessMcpCall = Readonly<{
  session: string;
  /** The harness's id for this call (tool-use id / request id). `ran` matches on it. */
  id: string;
  /** A reported name. */
  server: string;
  /** The server's own tool name; absent when the adapter cannot tell. */
  tool?: string;
  arguments: unknown;
}>;
/** What the control sees of a call. `direct`: the owner's own signed message
 * started the turn and nothing else steered it. */
export type HarnessMcpControlCall = HarnessMcpCall &
  Readonly<{
    agent: AgentKey;
    /** How long core waits for the answer, in milliseconds. */
    hold: number;
    direct: boolean;
    /** `message`: the event that started the turn, when one did. */
    conversation?: Readonly<{
      channel: string;
      root?: string;
      message?: string;
    }>;
  }>;
export type HarnessMcpControl = Readonly<{
  choose(agent: Agent): HarnessMcpChoice | undefined;
  /** Asked before a call the choice allows. No answer: allow. A reason: the
   * call must not run. An error, a late answer or any other value: deny. */
  call?(
    call: HarnessMcpControlCall,
  ): { deny: string } | undefined | Promise<{ deny: string } | undefined>;
  /** A call the harness ran that no `call` answer allowed. */
  skipped?(call: Omit<HarnessMcpCall, "arguments"> & { agent: AgentKey }): void;
}>;
/** What a harness lists as loaded in a session. */
export type HarnessMcpLoaded = readonly Readonly<{
  name: string;
  tools?: readonly string[];
}>[];

type Who = Pick<AgentHandle, "key" | "protection">;
/** Whether `trigger` is the owner's own signed message. A wake, a watch and an
 * attested sibling's message are not. */
export const directTrigger = (trigger: Trigger, owner: string | undefined) =>
  trigger.type === "mention" && !!owner && trigger.event.pubkey === owner;
/** The conversation a trigger came from, when it names one. */
function conversationOf(trigger: Trigger) {
  if ("channel" in trigger)
    return {
      channel: trigger.channel,
      ...(trigger.root && { root: trigger.root }),
    };
  if (!("event" in trigger)) return undefined;
  const channel = trigger.event.tags.find((tag) => tag[0] === "h")?.[1];
  const root = threadReference(trigger.event)?.rootId;
  const message = trigger.event.id;
  return channel
    ? { channel, ...(root && { root }), ...(message && { message }) }
    : undefined;
}
/** Runs `fn` as a promise: a throw is a rejection. It starts at once. */
const attempt = <T>(fn: () => T) =>
  new Promise<Awaited<T>>((resolve) => resolve(fn() as Awaited<T>));
/** Settles with `work`, or with a denial once `ms` pass or `signal` aborts. */
function held(work: Promise<unknown>, ms: number, signal: AbortSignal) {
  return new Promise<unknown>((resolve) => {
    const end = (value: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () =>
      end({ deny: "The turn ended before the owner answered" });
    const timer = setTimeout(
      () => end({ deny: "The owner did not answer in time" }),
      ms,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(end, () => end({ deny: "The MCP call policy failed" }));
  });
}
/** What one session started under. `allowed` holds the calls the control let
 * through that the harness has not yet shown as run; the next `started` of the
 * session replaces the record and empties it. */
type Session = Readonly<{
  choice: HarnessMcpChoice | "none";
  allowed: Set<string>;
}>;
/** Sessions kept for each agent. Past this the oldest is forgotten, and its
 * calls are denied (`call`) or reported as run (`ran`): the safe side. */
const SESSIONS_PER_AGENT = 64;
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
/** The choice as this session applied it: a server the choice leaves out
 * keeps the harness's default, so one that loaded anyway is on. */
function applied(
  choice: HarnessMcpChoice | "none",
  loaded: HarnessMcpLoaded,
): HarnessMcpChoice | "none" {
  if (choice === "none") return choice;
  const resolved: Record<string, boolean | readonly string[]> =
    Object.create(null);
  for (const { name } of loaded) resolved[name] = true;
  return Object.freeze(Object.assign(resolved, choice));
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
  /** Before a session's native MCP call runs, for a session `started` with
   * a choice. A reason: the call must not run. Never throws; every failure,
   * `hold` milliseconds without an answer and an abort of `signal` are
   * denials. Never for Buzz's own tools. */
  call(
    agent: Who,
    call: HarnessMcpCall,
    options: {
      hold: number;
      signal: AbortSignal;
      turn?: Pick<Delivery, "trigger">;
    },
  ): Promise<string | undefined>;
  /** A native call the harness shows as run. True: nothing allowed it, so
   * stop the turn. `rejected`: the harness blocked it, so it did not run.
   * `ungated`: the harness's own setting ran it without asking; that wins
   * where the session's choice leaves the tool on. */
  ran(
    agent: Who,
    call: Omit<HarnessMcpCall, "arguments"> & {
      rejected?: boolean;
      ungated?: boolean;
    },
  ): boolean;
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
  /** `ungated` is kept only when it is exactly `true`. */
  const tidy = (tools: readonly HarnessMcpTool[]): readonly HarnessMcpTool[] =>
    tools.map(({ ungated, ...tool }) =>
      ungated === true ? { ...tool, ungated } : tool,
    );
  /** Whether a session's applied choice leaves this server and tool on. A
   * call whose tool is unknown is off when the server leaves any tool out. */
  const allows = (
    choice: Session["choice"],
    { server, tool }: Pick<HarnessMcpCall, "server" | "tool">,
  ) => {
    const picked =
      choice !== "none" && Object.hasOwn(choice, server)
        ? choice[server]
        : false;
    if (!Array.isArray(picked)) return picked === true;
    return tool ? !picked.includes(tool) : picked.length === 0;
  };
  /** Each agent's sessions, oldest first. */
  const sessions = new Map<AgentKey, Map<string, Session>>();
  const recorded = (agent: AgentKey, session: string) =>
    sessions.get(agent)?.get(session);
  const record = (agent: AgentKey, session: string, next?: Session) => {
    const own = sessions.get(agent) ?? new Map<string, Session>();
    sessions.set(agent, own);
    own.delete(session);
    if (next) own.set(session, next);
    if (own.size > SESSIONS_PER_AGENT)
      own.delete(own.keys().next().value as string);
  };
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

  const kit: HarnessMcpKit = Object.freeze({
    choice: answer,
    started(agent, session, loaded, given) {
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
        record(agent.key, session);
        throw new Error(
          `Session ${session} loaded MCP servers that were turned off: ${extra.map(({ name }) => name).join(", ")}`,
        );
      }
      if (agent.protection) proofs.set(agent.key, agent.protection.key);
      record(
        agent.key,
        session,
        choice && {
          choice: applied(choice, loaded),
          allowed: new Set<string>(),
        },
      );
    },
    async call(agent, call, options) {
      try {
        const { hold, signal, turn } = options;
        if (agent.protection) return "A protected agent loads no MCP server";
        if (signal.aborted) return "The turn ended before the call was checked";
        const session = recorded(agent.key, call.session);
        if (!session) return "Buzz has no record of this session's MCP servers";
        if (!allows(session.choice, call))
          return `${call.server}${call.tool ? `.${call.tool}` : ""} is turned off for this agent`;
        const live = control;
        if (!live || state() !== "controlled")
          return "The plugin that controls MCP servers is not running";
        const owner = running(agent.key)?.owner;
        const conversation = turn && conversationOf(turn.trigger);
        const answer = live.value.call
          ? await held(
              attempt(() =>
                live.value.call?.({
                  agent: agent.key,
                  session: call.session,
                  id: call.id,
                  server: call.server,
                  ...(call.tool && { tool: call.tool }),
                  // A copy: a harness may run the call with the object it gave.
                  arguments: structuredClone(call.arguments),
                  hold,
                  direct: !!turn && directTrigger(turn.trigger, owner),
                  ...(conversation && { conversation }),
                }),
              ),
              hold,
              signal,
            )
          : undefined;
        if (answer !== undefined)
          return (
            (answer &&
              typeof answer === "object" &&
              "deny" in answer &&
              typeof answer.deny === "string" &&
              answer.deny) ||
            "The MCP call policy did not allow it"
          );
        // The session may have started again, the plugin stopped or the turn
        // ended meanwhile.
        if (signal.aborted) return "The turn ended before the call was allowed";
        if (
          recorded(agent.key, call.session) !== session ||
          control !== live ||
          state() !== "controlled"
        )
          return "The MCP call policy changed before it answered";
        session.allowed.add(call.id);
        return undefined;
      } catch {
        return "The MCP call could not be checked";
      }
    },
    ran(agent, call) {
      if (call.rejected) return false;
      const session = recorded(agent.key, call.session);
      if (session?.allowed.delete(call.id)) return false;
      if (
        call.ungated &&
        session &&
        !agent.protection &&
        allows(session.choice, call)
      )
        return false;
      if (
        control?.value.skipped &&
        !agent.protection &&
        state() === "controlled"
      )
        // A control that fails here changes nothing: the turn stops anyway.
        attempt(() =>
          control?.value.skipped?.({
            agent: agent.key,
            session: call.session,
            id: call.id,
            server: call.server,
            ...(call.tool && { tool: call.tool }),
          }),
        ).catch(() => undefined);
      return true;
    },
  });

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
        servers: report.servers.map((server) => {
          const tools = server.tools ?? seen.get(slot(key, server.name));
          return tools ? { ...server, tools: tidy(tools) } : server;
        }),
      };
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
      const kept = tidy(tools);
      seen.set(slot(key, server), kept);
      return kept;
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
