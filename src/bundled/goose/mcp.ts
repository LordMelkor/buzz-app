// Native configured Goose extensions. Raw launch configuration stays inside this
// adapter; plugins receive only names, state and the tools a session listed.
import type {
  HarnessMcpAnswer,
  HarnessMcpKit,
  HarnessMcpChoice,
  HarnessMcpLoaded,
  HarnessMcpServer,
} from "../../features/agents/harness-mcp";
import type { AgentHandle } from "../../features/agents/service";
import {
  type AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "../../features/agent-harness/acp/process";
import type { AcpHooks } from "../../features/agent-harness/acp/types";

type Who = Pick<AgentHandle, "key" | "protection">;
type Extension = {
  type: "mcp";
  server: { name: string };
  available_tools?: readonly string[];
};
type Configured = {
  name: string;
  key: string;
  enabled: boolean;
  extension: Extension;
  unavailable?: string;
};
const request = (
  p: AcpProcess,
  method: string,
  params: Record<string, unknown> = {},
) => p.request(`_goose/unstable/${method}`, params, REQUEST_TIMEOUT_MS);
const mcp = (e: { extension?: Extension }) =>
  e.extension?.type === "mcp" && e.extension.server?.name !== "buzz";

export class GooseMcp {
  constructor(
    private readonly kit: HarnessMcpKit,
    private readonly who: () => Who | undefined,
  ) {}

  private async configured(p: AcpProcess): Promise<Configured[]> {
    const { extensions } = (await request(p, "config/extensions/list")) as {
      extensions: {
        configKey: string;
        enabled: boolean;
        extension: Extension;
      }[];
    };
    if (!Array.isArray(extensions))
      throw new Error("Goose did not list its configured extensions");
    type Saved = {
      name?: string;
      envs?: object | null;
      env?: object | null;
      cwd?: unknown;
    };
    let saved: Record<string, Saved> | undefined;
    try {
      ({ value: saved } = (await request(p, "config/read", {
        key: "extensions",
        isSecret: false,
      })) as { value: Record<string, Saved> });
    } catch {
      // An unverifiable configuration can still be left Off, but never launched.
    }
    const settings = Object.entries(saved ?? {});
    return extensions
      .filter((e) => mcp(e) && e.configKey !== "buzz")
      .map((e) => {
        if (
          typeof e.configKey !== "string" ||
          typeof e.extension.server.name !== "string"
        )
          throw new Error("Goose returned invalid extension metadata");
        const name = e.extension.server.name;
        const matches = settings.filter(
          ([key, value]) =>
            value && typeof value === "object" && (value.name ?? key) === name,
        );
        const lost = [];
        if (
          matches.some(
            ([, value]) =>
              Object.keys(value.envs ?? {}).length ||
              Object.keys(value.env ?? {}).length,
          )
        )
          lost.push("environment values");
        if (matches.some(([, value]) => value.cwd != null))
          lost.push("working directory");
        const reason = !matches.length
          ? "its saved launch settings could not be verified"
          : lost.length
            ? `the API doesn't carry over its saved ${lost.join(" and ")}`
            : undefined;
        return {
          name,
          key: e.configKey,
          enabled: e.enabled,
          extension: e.extension,
          ...(reason && {
            unavailable: `Goose can't start ${name} for one session: ${reason}.`,
          }),
        };
      });
  }
  async report(p: AcpProcess) {
    const configured = await this.configured(p);
    const servers: HarnessMcpServer[] = configured.map(
      ({ name, enabled, unavailable }) => {
        return {
          name,
          default: false,
          ...(unavailable
            ? { state: "failed" as const, reason: unavailable }
            : !enabled && { state: "disabled" as const }),
        };
      },
    );
    return {
      tools: true,
      servers,
    };
  }
  async inspect(p: AcpProcess, cwd: string, name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const configured = (await this.configured(p)).find((e) => e.name === name);
    if (!configured)
      throw new Error(`Goose has no configured MCP server named ${name}`);
    if (configured.unavailable) throw new Error(configured.unavailable);
    signal.throwIfAborted();
    const { sessionId } = (await p.request(
      "session/new",
      {
        cwd,
        mcpServers: [],
        _meta: { enabledExtensions: [configured.extension] },
      },
      REQUEST_TIMEOUT_MS,
    )) as { sessionId: string };
    signal.throwIfAborted();
    const { tools } = await this.tools(p, sessionId, configured);
    signal.throwIfAborted();
    return tools;
  }
  private async tools(
    p: AcpProcess,
    sessionId: string,
    entry: Pick<Configured, "name" | "key">,
  ) {
    const { tools } = (await request(p, "tools/list", {
      sessionId,
      extensionName: entry.key,
    })) as {
      tools: {
        name: string;
        description?: string;
        permission?: string | null;
      }[];
    };
    if (!Array.isArray(tools))
      throw new Error("Goose did not list its MCP tools");
    const prefix = `${entry.key}__`;
    const own = tools.map((t) => ({
      name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
      ...(typeof t.description === "string" && { description: t.description }),
    }));
    return { tools: own };
  }

  private selection(configured: Configured[], choice: HarnessMcpAnswer) {
    const selected: Configured[] = [];
    const applied: Record<string, HarnessMcpChoice[string]> =
      Object.create(null);
    for (const entry of configured) {
      const pick =
        choice && choice !== "none" && Object.hasOwn(choice, entry.name)
          ? (choice[entry.name] ?? false)
          : false;
      applied[entry.name] = pick;
      if (pick === true) selected.push(entry);
      else if (pick && typeof pick === "object") {
        const available = pick.known.filter(
          (name) =>
            !pick.off.includes(name) &&
            (!entry.extension.available_tools?.length ||
              entry.extension.available_tools.includes(name)),
        );
        // Goose interprets [] as unrestricted: all-off must omit the extension.
        if (available?.length)
          selected.push({
            ...entry,
            extension: { ...entry.extension, available_tools: available },
          });
      }
    }
    for (const entry of selected)
      if (entry.unavailable) throw new Error(entry.unavailable);
    return { selected, applied };
  }
  hooks(base: AcpHooks): AcpHooks {
    const initial = new WeakMap<
      object,
      { choice: HarnessMcpAnswer; owner: boolean }
    >();
    return {
      ...base,
      newSessionMeta: async (buzz, open, process) => {
        const meta = (await base.newSessionMeta?.(buzz, open, process)) ?? {};
        const agent = this.who();
        const choice = agent?.protection
          ? "none"
          : agent
            ? await this.kit.choice(agent)
            : "none";
        const owner = !!buzz && !open.platform;
        initial.set(meta, { choice, owner });
        if (choice === undefined || !owner) return meta;
        if (!process) throw new Error("Goose native session is unavailable");
        const { selected } = this.selection(
          await this.configured(process),
          choice,
        );
        const selectedMeta = {
          ...meta,
          enabledExtensions: [
            ...(meta.enabledExtensions as unknown[]),
            ...selected.map((e) => e.extension),
          ],
        };
        initial.set(selectedMeta, { choice, owner });
        return selectedMeta;
      },
      sessionOpened: (p, session, meta) => {
        const opened = meta && initial.get(meta);
        let choice = opened?.choice;
        session.controls = {
          beforePrompt: async (signal) => {
            const agent = this.who();
            if (!agent) throw new Error("The Goose agent is unavailable");
            const supplied = agent.protection
              ? "none"
              : await this.kit.choice(agent);
            const next =
              supplied === undefined
                ? undefined
                : opened?.owner
                  ? supplied
                  : "none";
            signal.throwIfAborted();
            if (next === undefined && choice === undefined) return;
            const configured = await this.configured(p);
            const { selected, applied } = this.selection(configured, next);
            const { extensions } = (await request(
              p,
              "session/extensions/list",
              { sessionId: session.id },
            )) as {
              extensions: { extensionKey: string; extension: Extension }[];
            };
            const wanted = new Map(selected.map((e) => [e.key, e]));
            for (const entry of extensions.filter(mcp))
              if (!wanted.has(entry.extensionKey))
                await request(p, "session/extensions/remove", {
                  sessionId: session.id,
                  extensionKey: entry.extensionKey,
                });
            for (const entry of selected)
              await request(p, "session/extensions/add", {
                sessionId: session.id,
                extension: entry.extension,
              });
            const actual = (await request(p, "session/extensions/list", {
              sessionId: session.id,
            })) as {
              extensions: { extensionKey: string; extension: Extension }[];
            };
            const loaded: HarnessMcpLoaded[number][] = [];
            for (const entry of actual.extensions.filter(mcp)) {
              const known = configured.find(
                (e) => e.key === entry.extensionKey,
              );
              if (!known)
                throw new Error("Goose loaded an unconfigured MCP server");
              const item = known;
              const { tools } = await this.tools(p, session.id, item);
              loaded.push({ name: item.name, state: "connected", tools });
            }
            this.kit.started(
              agent,
              session.id,
              loaded,
              next === undefined ? "none" : applied,
            );
            signal.throwIfAborted();
            choice = next;
          },
        };
        base.sessionOpened?.(p, session, meta);
      },
    };
  }
}
