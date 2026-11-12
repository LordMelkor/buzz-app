import type { HostProcessOptions } from "../../features/host/service";
import { fakeSpawn } from "./goose-testing";

export const native = (name: string) => ({
  type: "mcp",
  server: {
    name,
    command: "/fixture",
    args: ["private-config"],
    env: [{ name: "TOKEN", value: "fixture-secret" }],
  },
});
const configured = [
  {
    configKey: "developer",
    enabled: true,
    extension: { type: "platform", name: "developer" },
  },
  {
    configKey: "summon",
    enabled: true,
    extension: { type: "platform", name: "summon" },
  },
  { configKey: "fixture", enabled: true, extension: native("fixture") },
  { configKey: "other", enabled: false, extension: native("other") },
  { configKey: "buzz", enabled: true, extension: native("buzz") },
];
type Selected = {
  type: string;
  name?: string;
  server?: { name: string };
  available_tools?: string[];
};

/** Native protocol fixture layered over the existing ACP spawn boundary. */
export function transport() {
  const fake = fakeSpawn({ hold: true });
  const sessions = new Map<string, Selected[]>();
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let failTools = false;
  const permissions = new Map<string, string | null>();
  let toolBarrier: (() => void) | undefined;
  const wrap =
    (base: typeof fake.spawn): typeof fake.spawn =>
    async (id, options: HostProcessOptions = {}) => {
      const process = await base(id, options);
      let sequence = 0;
      return {
        ...process,
        write: async (data: string) => {
          const wire = JSON.parse(data);
          const { method, params = {} } = wire;
          if (!method) return process.write(data);
          requests.push({ method, params });
          const reply = (result: unknown) =>
            options.onStdout?.(
              `${JSON.stringify({ jsonrpc: "2.0", id: wire.id, result })}\n`,
            );
          if (method === "_goose/unstable/config/extensions/list")
            return reply({ extensions: configured });
          if (method === "session/new")
            sessions.set(
              `session-${++sequence}`,
              params._meta?.enabledExtensions ?? [],
            );
          const session = sessions.get(params.sessionId) ?? [];
          if (method === "_goose/unstable/session/extensions/list")
            return reply({
              extensions: session.map((extension) => ({
                extensionKey: extension.server?.name ?? extension.name,
                extension,
              })),
            });
          if (method === "_goose/unstable/session/extensions/remove") {
            sessions.set(
              params.sessionId,
              session.filter((e) => e.server?.name !== params.extensionKey),
            );
            return reply({});
          }
          if (method === "_goose/unstable/session/extensions/add") {
            sessions.set(params.sessionId, [
              ...session.filter(
                (e) => e.server?.name !== params.extension.server.name,
              ),
              params.extension,
            ]);
            return reply({});
          }
          if (method === "session/set_mode") return reply({});
          if (method === "_goose/unstable/tools/list") {
            if (toolBarrier) {
              toolBarrier();
              return;
            }
            if (failTools)
              return options.onStdout?.(
                `${JSON.stringify({ jsonrpc: "2.0", id: wire.id, error: { code: -32603, message: "Tool listing failed" } })}\n`,
              );
            const selected = session.find(
              (e) => e.server?.name === params.extensionName,
            );
            const names = selected
              ? selected.available_tools?.length
                ? selected.available_tools
                : ["read_echo", "write_marker"]
              : [];
            return reply({
              tools: names.map((name) => ({
                name: `${params.extensionName}__${name}`,
                description: name,
                permission: permissions.get(name),
              })),
            });
          }
          return process.write(data);
        },
      };
    };
  return {
    fake,
    spawn: wrap(fake.spawn),
    wrap,
    requests,
    permission: (name: string, value: string | null) =>
      permissions.set(name, value),
    failTools: () => {
      failTools = true;
    },
    holdTools: (started: () => void) => {
      toolBarrier = started;
    },
  };
}
