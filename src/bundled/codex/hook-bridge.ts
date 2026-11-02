import type { Host } from "../../features/host/service";
import { nativeHookArgs } from "./hooks";

const SERVER = "buzz_native_hooks";
const fields = {
  PreToolUse: ["tool_name", "tool_input", "tool_use_id"],
  PostToolUse: ["tool_name", "tool_input", "tool_use_id", "tool_response"],
  PermissionRequest: ["tool_name", "tool_input"],
  UserPromptSubmit: ["prompt"],
  Stop: ["stop_hook_active", "last_assistant_message"],
  PreCompact: ["trigger"],
  PostCompact: ["trigger"],
  SessionStart: ["source"],
  Interrupt: [],
} as const;
export const CODEX_HOOK_EVENTS = Object.keys(fields);
/** One fixed dispatcher per native event, independent of plugin registrations. */
export const callbackHookArgs = nativeHookArgs(
  Object.fromEntries(
    Object.entries(fields).map(([event, names]) => [
      event,
      [
        {
          matcher: ".*",
          hooks: [
            {
              type: "mcp_tool",
              server: SERVER,
              tool: event,
              input: Object.fromEntries(
                [
                  "session_id",
                  "cwd",
                  "hook_event_name",
                  "transcript_path",
                  ...names,
                ].map((name) => [name, `\${${name}}`]),
              ),
              timeout: event === "Interrupt" ? 3 : 30,
            },
          ],
        },
      ],
    ]),
  ),
);

/** The authenticated MCP endpoint belongs to one thread admission, not a model
 * tool server. Its closure fixes the agent; native input cannot select another. */
export async function openHookBridge(
  serve: NonNullable<Host["serveMcp"]>,
  run: (
    session: string,
    event: string,
    input: unknown,
  ) => Promise<Record<string, unknown>>,
) {
  let session: string | undefined;
  let closed = false;
  const server = await serve(
    async (value) => {
      const wire = value as {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (wire.id == null) return;
      const result = (result: unknown) => ({
        jsonrpc: "2.0",
        id: wire.id,
        result,
      });
      if (wire.method === "initialize")
        return result({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER, version: "1" },
        });
      // Hooks call the dispatcher directly. Do not advertise it to the model.
      if (wire.method === "tools/list") return result({ tools: [] });
      if (wire.method !== "tools/call") return result({});
      const event = wire.params?.name ?? "";
      const input = wire.params?.arguments;
      if (
        closed ||
        !CODEX_HOOK_EVENTS.includes(event) ||
        typeof input?.session_id !== "string"
      )
        throw new Error("Invalid Codex hook callback");
      if (session !== input.session_id)
        throw new Error("Codex hook session mismatch");
      const output = await run(session, event, input);
      return result({
        content: [{ type: "text", text: JSON.stringify(output) }],
      });
    },
    { sharedSession: true },
  );
  return {
    config: {
      [SERVER]: {
        url: server.url,
        http_headers: Object.fromEntries(
          server.headers.map(({ name, value }) => [name, value]),
        ),
        enabled: true,
        required: true,
      },
    },
    bind(id: string) {
      if (session !== undefined && session !== id)
        throw new Error("Codex hook session mismatch");
      session = id;
    },
    async close() {
      closed = true;
      await server.close();
    },
  };
}
