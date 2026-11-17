import type {
  HarnessMcpAnswer,
  HarnessMcpChoice,
  HarnessMcpLoaded,
  HarnessMcpServer,
} from "../../features/agents/harness-mcp";
import type { Host } from "../../features/host/service";

export type ClaudeMcp = Readonly<{
  choice: HarnessMcpAnswer;
  servers: readonly HarnessMcpServer[];
  inspect?: string;
  started(
    session: string,
    loaded: HarnessMcpLoaded,
    applied: HarnessMcpChoice | "none",
  ): void;
}>;
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
export async function configuredMcp(read: Host["readFile"], cwd: string) {
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
  const rows = new Map<string, HarnessMcpServer>();
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
    Object.entries({
      ...Object.fromEntries(
        names.map((server) => [server.name, server.default]),
      ),
      ...choice,
    }).map(([name, pick]) => [
      name,
      mcp.inspect ? name === mcp.inspect : (pick ?? false),
    ]),
  );
}
export function mcpSettings(mcp: ClaudeMcp) {
  const choice = mcpChoice(mcp);
  return {
    deniedMcpServers: [
      ...(choice === "none"
        ? mcp.servers.map(({ name }) => ({ serverName: name }))
        : Object.entries(choice)
            .filter(([, pick]) => pick === false)
            .map(([name]) => ({ serverName: name }))),
      // Inspection installs no SDK server to shadow a native definition.
      ...(mcp.inspect ? [{ serverName: "buzz" }] : []),
    ],
    permissions: {
      deny:
        choice === "none"
          ? []
          : Object.entries(choice).flatMap(([server, tools]) =>
              typeof tools === "object"
                ? tools.off.map(
                    (tool) => `mcp__${mcpName(server)}__${mcpName(tool)}`,
                  )
                : [],
            ),
    },
  };
}
