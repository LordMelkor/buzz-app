import type { Delivery } from "../../features/agents/service";

export type ClaudeTurn = Pick<Delivery, "trigger">;

/** Claude SDK hook callbacks travel over the process's control channel. */
export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "Notification",
] as const;
export type ClaudeHook = (
  session: string,
  event: string,
  input: unknown,
  turn?: ClaudeTurn,
) => Promise<Record<string, unknown>>;
