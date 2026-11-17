import type { AcpHooks } from "../../features/agent-harness/acp/types";
import type { AcpSession } from "../../features/agent-harness/acp/session";

export const GOOSE_HOOK_EVENTS = [
  "PromptSubmit",
  "PermissionRequest",
  "ToolCall",
] as const;
export type GooseHook = (
  session: AcpSession,
  event: (typeof GOOSE_HOOK_EVENTS)[number],
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** ACP notifications cannot block execution. Permission requests can. */
export function gooseHooks(
  base: AcpHooks,
  hook?: GooseHook,
  names: (
    session: AcpSession,
    input: Record<string, unknown>,
  ) => object = () => ({}),
): AcpHooks {
  if (!hook) return base;
  return {
    ...base,
    sessionOpened(process, session, meta) {
      base.sessionOpened?.(process, session, meta);
      const controls = session.controls;
      // Correlate protocol payloads, never policy: observed → asked → answered.
      type Call = {
        input: Record<string, unknown>;
        answer?: Promise<"allow" | "deny">;
      };
      let calls = new Map<string, Call>();
      const input = (value: Record<string, unknown>) => {
        const native = (
          value._meta as
            | { goose?: { toolCall?: { toolName?: string } } }
            | undefined
        )?.goose?.toolCall;
        return {
          ...value,
          session_id: session.id,
          tool_use_id: value.toolCallId,
          ...(native?.toolName && { tool_name: native.toolName }),
          ...(Object.hasOwn(value, "rawInput") && {
            tool_input: value.rawInput,
          }),
          ...names(session, value),
        };
      };
      const observe = async (
        value: Record<string, unknown>,
        signal: AbortSignal,
        turn = calls,
      ) => {
        try {
          const output = await hook(session, "ToolCall", value);
          if (
            typeof output.stop === "string" &&
            !signal.aborted &&
            turn === calls
          )
            session.interrupt();
        } catch (error) {
          console.warn("Goose tool hook failed", error);
        }
      };
      session.controls = {
        beforePrompt: async (signal) => {
          calls = new Map();
          await controls?.beforePrompt?.(signal);
          const output = await hook(session, "PromptSubmit", {
            session_id: session.id,
          });
          if (typeof output.stop === "string") throw new Error(output.stop);
          signal.throwIfAborted();
        },
        permission: async (params) => {
          const tool = (params.toolCall ?? {}) as Record<string, unknown>;
          const id = String(tool.toolCallId);
          const observed: Call = calls.get(id) ?? { input: input(tool) };
          calls.set(id, observed);
          const signal = session.signal;
          const answering = (async () => {
            const output = await hook(session, "PermissionRequest", {
              ...params,
              ...observed.input,
              // Permission payloads can supply fuller input than the first update.
              ...(Object.hasOwn(tool, "rawInput") && {
                tool_input: tool.rawInput,
              }),
            });
            const decision: "allow" | "deny" =
              output.decision === "deny" || signal.aborted ? "deny" : "allow";
            if (signal.aborted)
              return { decision, outcome: { outcome: "cancelled" } };
            const selected = (
              params.options as { kind: string; optionId: string }[] | undefined
            )?.find(
              (o) =>
                o.kind ===
                (decision === "allow" ? "allow_once" : "reject_once"),
            );
            return {
              decision: selected ? decision : ("deny" as const),
              outcome: selected
                ? { outcome: "selected", optionId: selected.optionId }
                : { outcome: "cancelled" },
            };
          })();
          observed.answer = answering.then(
            (result) => result.decision,
            () => "deny",
          );
          return (await answering).outcome;
        },
        update: (update) => {
          controls?.update?.(update);
          const id = String(update.toolCallId);
          const signal = session.signal;
          if (update.sessionUpdate === "tool_call") {
            const observed = { input: input(update) };
            calls.set(id, observed);
            void observe(observed.input, signal);
          } else if (
            update.sessionUpdate === "tool_call_update" &&
            ["completed", "failed"].includes(String(update.status))
          ) {
            const observed = calls.get(id);
            calls.delete(id);
            const turn = calls;
            void (async () => {
              const decision = await observed?.answer;
              if (signal.aborted || turn !== calls) return;
              await observe(
                {
                  ...observed?.input,
                  ...update,
                  session_id: session.id,
                  tool_use_id: update.toolCallId,
                  ...(Object.hasOwn(update, "rawOutput") && {
                    tool_response: update.rawOutput,
                  }),
                  ...(decision && { permission_decision: decision }),
                },
                signal,
                turn,
              );
            })();
          }
        },
      };
    },
  };
}
