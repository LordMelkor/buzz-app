// What a harness's session updates show, and how its requests are answered.

const STEP_KEYS = [
  "description",
  "path",
  "file_path",
  "pattern",
  "url",
  "query",
  "command",
];

/** A `session/update` as the step it shows: a tool call by its title and
 * target, thinking, or writing. */
export function stepLabel(
  update: Record<string, unknown>,
): { tool: string; target?: string } | undefined {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const title = typeof update.title === "string" ? update.title : "";
      // goose titles a call `shell · sleep 10`, or `buzz: send`.
      const tool =
        title.split(" · ")[0]?.split(/__|: /).at(-1)?.trim() || "Tool";
      const input = (update.rawInput ?? {}) as Record<string, unknown>;
      const target = STEP_KEYS.map((key) => input[key]).find(
        (value): value is string => typeof value === "string" && !!value,
      );
      return target ? { tool, target: shortTarget(target) } : { tool };
    }
    case "agent_thought_chunk":
      return { tool: "Thinking" };
    case "agent_message_chunk":
      return { tool: "Writing reply" };
    default:
      return undefined;
  }
}

/** The option that allows the call, preferring one that keeps allowing. */
export function allow(params: Record<string, unknown>) {
  const options = Array.isArray(params.options)
    ? (params.options as { optionId?: unknown; kind?: unknown }[])
    : [];
  const option =
    options.find((item) => item.kind === "allow_always") ??
    options.find((item) => item.kind === "allow_once");
  return option && typeof option.optionId === "string"
    ? { outcome: "selected", optionId: option.optionId }
    : { outcome: "cancelled" };
}

/** The JSON-RPC code of a harness's error answer, when `error` is one. */
export function codeOf(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const { message, data } = error as { message: unknown; data?: unknown };
    return typeof data === "string" && data
      ? `${message}: ${data}`
      : String(message);
  }
  return String(error);
}

function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}
