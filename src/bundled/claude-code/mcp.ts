import type {
  HarnessMcpAnswer,
  HarnessMcpChoice,
  HarnessMcpKit,
  HarnessMcpLoaded,
  HarnessMcpServer,
} from "../../features/agents/harness-mcp";
import type { AgentHandle, Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";

type Call = {
  session: string;
  id: string;
  server: string;
  tool?: string;
  arguments: unknown;
};
/** Kept at this adapter boundary until the gate lands in the shared kit. */
type Gate = {
  call(
    agent: AgentHandle,
    call: Call,
    options: {
      hold: number;
      signal: AbortSignal;
      turn?: Pick<Delivery, "trigger">;
    },
  ): Promise<string | undefined>;
  ran(
    agent: AgentHandle,
    call: Omit<Call, "arguments"> & { rejected?: boolean },
  ): boolean;
};
export type ClaudeMcpKit = HarnessMcpKit & Partial<Gate>;
export type ClaudeMcpTurn = Pick<Delivery, "trigger">;
export type ClaudeMcp = Readonly<{
  owner?: string;
  choice: HarnessMcpAnswer;
  servers: readonly HarnessMcpServer[];
  inspect?: string;
  started(
    session: string,
    loaded: HarnessMcpLoaded,
    applied: HarnessMcpChoice | "none",
    servers: readonly HarnessMcpServer[],
  ): void;
  call?(
    call: Call,
    signal: AbortSignal,
    turn?: ClaudeMcpTurn,
  ): Promise<string | undefined>;
  ran?(call: Omit<Call, "arguments"> & { rejected?: boolean }): boolean;
}>;
export const MCP_NOTE =
  "Servers from other sources appear after this agent’s next session.";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
export const mcpName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Reads metadata only. Native Claude remains the owner of definitions and policy. */
export async function configuredMcp(
  read: Host["readFile"],
  cwd: string,
  seen: readonly HarnessMcpServer[] = [],
) {
  const json = async (path: string) => {
    if (!read) return {};
    try {
      return object(
        JSON.parse(new TextDecoder().decode(await read(path, { cwd }))),
      );
    } catch {
      return {};
    }
  };
  const [user, project, userSettings, projectSettings, localSettings] =
    await Promise.all([
      json("~/.claude.json"),
      json(".mcp.json"),
      json("~/.claude/settings.json"),
      json(".claude/settings.json"),
      json(".claude/settings.local.json"),
    ]);
  const local = object(object(user.projects)[cwd]);
  const disabled = new Set([
    ...strings(user.disabledMcpServers),
    ...strings(local.disabledMcpServers),
  ]);
  const approved = new Set(strings(local.enabledMcpjsonServers));
  const rejected = new Set(strings(local.disabledMcpjsonServers));
  const all =
    { ...userSettings, ...projectSettings, ...localSettings }
      .enableAllProjectMcpServers === true;
  const rows = new Map(seen.map((server) => [server.name, server]));
  for (const [servers, needsApproval] of [
    [user.mcpServers, false],
    [local.mcpServers, false],
    [project.mcpServers, true],
  ] as const)
    for (const name of Object.keys(object(servers))) {
      if (name === "buzz") continue;
      const off =
        disabled.has(name) ||
        (needsApproval &&
          (rejected.has(name) || (!all && !approved.has(name))));
      rows.set(name, {
        ...rows.get(name),
        name,
        default: !off,
        ...(off ? { state: "disabled" as const } : {}),
      });
    }
  return [...rows.values()];
}

export function mcpChoice(
  mcp: ClaudeMcp,
  names: readonly HarnessMcpServer[] = mcp.servers,
): HarnessMcpChoice | "none" {
  const choice = mcp.choice;
  if (choice === "none") return "none";
  return Object.fromEntries(
    names.map((server) => [
      server.name,
      mcp.inspect
        ? server.name === mcp.inspect
        : Object.hasOwn(choice ?? {}, server.name)
          ? (choice?.[server.name] ?? false)
          : server.default,
    ]),
  );
}
export function mcpSettings(mcp: ClaudeMcp) {
  const choice = mcpChoice(mcp);
  return {
    deniedMcpServers: mcp.servers
      .filter(({ name }) => choice === "none" || choice[name] === false)
      .map(({ name }) => ({ serverName: name })),
    permissions: {
      ask: choice === "none" ? [] : ["mcp__*"],
      deny:
        choice === "none"
          ? []
          : Object.entries(choice).flatMap(([server, tools]) =>
              Array.isArray(tools)
                ? tools.map((tool) => `mcp__${mcpName(server)}__${tool}`)
                : [],
            ),
    },
  };
}

/** The only gate-to-core binding; execution targets never receive it. */
export function nativeMcpGate(
  kit: ClaudeMcpKit,
  agent: AgentHandle,
): Pick<ClaudeMcp, "call" | "ran" | "owner"> {
  return {
    owner: agent.owner,
    call: (call, signal, context) => {
      return kit.call
        ? kit.call(agent, call, {
            hold: 120_000,
            signal,
            ...(context ? { turn: context } : {}),
          })
        : Promise.resolve("The MCP control is unavailable");
    },
    ran: (call) => kit.ran?.(agent, call) ?? true,
  };
}
