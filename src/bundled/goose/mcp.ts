// Native configured Goose extensions. Raw launch configuration stays inside this
// adapter; plugins receive only names, state and the tools a session listed.
import type {
  HarnessMcpAnswer,
  HarnessMcpCall as Call,
  HarnessMcpKit,
  HarnessMcpTool,
} from "../../features/agents/harness-mcp";
import type { AgentHandle, Delivery } from "../../features/agents/service";
import {
  type AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "../../features/agent-harness/acp/process";
import type { AcpSession } from "../../features/agent-harness/acp/session";
import type { AcpHooks } from "../../features/agent-harness/acp/types";
import { allow } from "../../features/agent-harness/acp/steps";

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
};
const request = (
  p: AcpProcess,
  method: string,
  params: Record<string, unknown> = {},
) => p.request(`_goose/unstable/${method}`, params, REQUEST_TIMEOUT_MS);
const mcp = (e: { extension?: Extension }) =>
  e.extension?.type === "mcp" && e.extension.server?.name !== "buzz";
const option = (params: Record<string, unknown>, kind: string) => {
  const found = (
    params.options as { kind: string; optionId: string }[] | undefined
  )?.find((o) => o.kind === kind);
  return found
    ? { outcome: "selected", optionId: found.optionId }
    : { outcome: "cancelled" };
};

export class GooseMcp {
  private catalog = new Map<string, readonly HarnessMcpTool[]>();
  private seen = new Map<string, readonly HarnessMcpTool[]>();
  constructor(
    private readonly kit: HarnessMcpKit,
    private readonly who: () => Who | undefined,
    private readonly turn: (
      session: AcpSession,
    ) => Pick<Delivery, "trigger"> | undefined = () => undefined,
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
    return extensions
      .filter((e) => mcp(e) && e.configKey !== "buzz")
      .map((e) => {
        if (
          typeof e.configKey !== "string" ||
          typeof e.extension.server.name !== "string"
        )
          throw new Error("Goose returned invalid extension metadata");
        return {
          name: e.extension.server.name,
          key: e.configKey,
          enabled: e.enabled,
          extension: e.extension,
        };
      });
  }
  async report(p: AcpProcess) {
    const servers = (await this.configured(p)).map(({ name, enabled }) => {
      const tools = this.seen.get(name);
      return {
        name,
        default: false,
        ...(!enabled && { state: "disabled" as const }),
        ...(tools && { tools }),
      };
    });
    return {
      tools: true,
      calls: true as const,
      servers,
      note: "Tool inspection starts only the selected server, without a model turn. Goose may refresh its provider catalog. List tools before excluding individual tools. Native preallowed tools can skip approval; their results are checked afterward.",
    };
  }
  async inspect(p: AcpProcess, cwd: string, name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const configured = (await this.configured(p)).find((e) => e.name === name);
    if (!configured)
      throw new Error(`Goose has no configured MCP server named ${name}`);
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
    const tools = await this.tools(p, sessionId, configured);
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
      ...(t.permission === "always_allow" && { ungated: true as const }),
    }));
    this.catalog.set(entry.name, [
      ...new Map(
        [...(this.catalog.get(entry.name) ?? []), ...own].map((t) => [
          t.name,
          t,
        ]),
      ).values(),
    ]);
    this.seen.set(entry.name, own);
    return own;
  }
  private selection(configured: Configured[], choice: HarnessMcpAnswer) {
    const selected: Configured[] = [];
    const applied: Record<string, boolean | readonly string[]> =
      Object.create(null);
    for (const entry of configured) {
      const pick =
        choice && choice !== "none" && Object.hasOwn(choice, entry.name)
          ? (choice[entry.name] ?? false)
          : false;
      applied[entry.name] = pick;
      if (pick === true || (Array.isArray(pick) && pick.length === 0))
        selected.push(entry);
      else if (Array.isArray(pick)) {
        const catalog = this.catalog.get(entry.name);
        // An unknown catalog cannot safely express "all except" before startup.
        const available = catalog
          ?.map((t) => t.name)
          .filter(
            (name) =>
              !pick.includes(name) &&
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
        const curated = new Set(
          ((meta?.enabledExtensions as { type: string; name?: string }[]) ?? [])
            .filter((e) => e.type !== "mcp")
            .map((e) => e.name),
        );
        let native = new Map<
          string,
          Configured & { tools: readonly { name: string; ungated?: true }[] }
        >();
        type Observed = {
          call?: Call;
          ungated?: true;
          phase: "observed" | "unavailable" | "held" | "allowed" | "denied";
        };
        const calls = new Map<string, Observed>();
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
            await p.request(
              "session/set_mode",
              {
                sessionId: session.id,
                modeId: next === undefined ? "auto" : "approve",
              },
              REQUEST_TIMEOUT_MS,
            );
            const actual = (await request(p, "session/extensions/list", {
              sessionId: session.id,
            })) as {
              extensions: { extensionKey: string; extension: Extension }[];
            };
            native = new Map();
            const loaded = [];
            for (const entry of actual.extensions.filter(mcp)) {
              const known = configured.find(
                (e) => e.key === entry.extensionKey,
              );
              if (!known)
                throw new Error("Goose loaded an unconfigured MCP server");
              const item = known;
              const tools = await this.tools(p, session.id, item);
              native.set(item.key, { ...item, tools });
              loaded.push({ name: item.name, tools: tools.map((t) => t.name) });
            }
            this.kit.started(
              agent,
              session.id,
              loaded,
              next === undefined ? "none" : applied,
            );
            signal.throwIfAborted();
            choice = next;
            calls.clear();
          },
          permission: async (params) => {
            if (choice === undefined) return allow(params);
            const signal = session.signal;
            if (signal.aborted) return option(params, "reject_once");
            const id = String(
              (params.toolCall as { toolCallId?: unknown } | undefined)
                ?.toolCallId,
            );
            const observed = calls.get(id);
            if (observed && !observed.call) return option(params, "allow_once");
            if (!observed?.call) return option(params, "reject_once");
            if (observed.phase === "unavailable") {
              observed.phase = "denied";
              return option(params, "reject_once");
            }
            observed.phase = "held";
            const agent = this.who();
            const gate = this.kit;
            let reason: string | undefined = "The MCP control is unavailable";
            try {
              if (agent) {
                const turn = this.turn(session);
                reason = await gate.call(agent, observed.call, {
                  hold: 120_000,
                  signal,
                  ...(turn && { turn }),
                });
              }
            } catch {
              /* A failed gate must answer the pending native request with denial. */
            }
            observed.phase =
              reason !== undefined || signal.aborted ? "denied" : "allowed";
            return option(
              params,
              observed.phase === "allowed" ? "allow_once" : "reject_once",
            );
          },
          update: (update) => {
            if (choice === undefined) return;
            const id = String(update.toolCallId);
            if (update.sessionUpdate === "tool_call") {
              const meta = update._meta as
                | {
                    goose?: {
                      toolCall?: { extensionName?: string; toolName?: string };
                    };
                  }
                | undefined;
              const tool = meta?.goose?.toolCall;
              const entry =
                tool?.extensionName && native.get(tool.extensionName);
              if (entry) {
                const admitted = entry.tools.find(
                  (t) => `${entry.key}__${t.name}` === tool?.toolName,
                );
                calls.set(id, {
                  phase: admitted ? "observed" : "unavailable",
                  ...(admitted?.ungated && { ungated: true }),
                  call: {
                    session: session.id,
                    id,
                    server: entry.name,
                    ...(tool?.toolName?.startsWith(`${entry.key}__`) && {
                      tool: tool.toolName.slice(entry.key.length + 2),
                    }),
                    arguments: update.rawInput,
                  },
                });
              } else if (
                tool?.toolName &&
                (!tool.toolName.includes("__") ||
                  tool.extensionName === "buzz" ||
                  curated.has(tool.extensionName))
              )
                calls.set(id, { phase: "observed" });
            }
            if (
              update.sessionUpdate !== "tool_call_update" ||
              !["completed", "failed"].includes(String(update.status))
            )
              return;
            const observed = calls.get(id);
            calls.delete(id);
            const agent = this.who();
            const gate = this.kit;
            if (!observed?.call || !agent) return;
            // A forced call to a filtered tool has a failed result, but never ran.
            if (
              observed.phase === "unavailable" &&
              update.status === "failed" &&
              JSON.stringify(update.content ?? []).includes("not available")
            )
              return;
            const { arguments: _arguments, ...call } = observed.call;
            const rejected = observed.phase === "denied";
            if (
              gate.ran(agent, {
                ...call,
                ...(rejected && { rejected }),
                ...(observed.ungated && { ungated: true }),
              })
            )
              session.interrupt();
          },
        };
      },
    };
  }
}
