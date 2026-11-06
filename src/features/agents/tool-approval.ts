// Owner approval for a plugin tool's call: the tool asks, a notice shows the
// person using Buzz Allow once, Always allow and Deny, and the call goes on or
// fails with their answer. "Always allow" is remembered on this device for the
// plugin's tool, across agents, so the next call does not ask. Pending asks
// live in memory only: they end with the turn that made them or the app.
import { localStore, type AgentStore } from "./store";

export const TOOL_ALLOWED_PREFIX = "buzz.plugin-tool-allowed.v1:";
/** As agent creation drafts are: few, so a looping tool cannot bury the owner. */
const PENDING_MAX = 16;

export type ToolApprovalAnswer = "once" | "always" | "deny";
/** What a tool asks, and which plugin tool and agent are asking. */
export type ToolApprovalAsk = Readonly<{
  plugin: string;
  tool: string;
  title: string;
  detail: string;
}>;
export type ToolApprovalRequest = ToolApprovalAsk &
  Readonly<{ id: string; agent: string }>;
export type ToolApprovals = ReturnType<typeof createToolApprovals>;

export function createToolApprovals(storage: AgentStore = localStore()) {
  let pending: readonly ToolApprovalRequest[] = [];
  const waiting = new Map<
    string,
    Readonly<{
      settle(answer: Exclude<ToolApprovalAnswer, "deny">): void;
      deny(error: Error): void;
    }>
  >();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const allowedKey = (ask: ToolApprovalAsk) =>
    `${TOOL_ALLOWED_PREFIX}${ask.plugin}/${ask.tool}`;
  const remove = (id: string) => {
    waiting.delete(id);
    pending = pending.filter((request) => request.id !== id);
    notify();
  };
  return {
    pending: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Resolves once the owner allows the call (`always` when it is already
     * remembered); rejects when they deny it or `signal` aborts. */
    async ask(
      agent: string,
      ask: ToolApprovalAsk,
      signal?: AbortSignal,
    ): Promise<"once" | "always"> {
      signal?.throwIfAborted();
      if (storage.get(allowedKey(ask)) === "1") return "always";
      if (pending.length >= PENDING_MAX)
        throw new Error(
          "Your owner has too many approvals waiting. Try later.",
        );
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => {
          remove(id);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        waiting.set(id, {
          settle: (answer) => {
            signal?.removeEventListener("abort", abort);
            resolve(answer);
          },
          deny: (error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        });
        pending = [...pending, { ...ask, id, agent }];
        notify();
      });
    },
    answer(id: string, answer: ToolApprovalAnswer) {
      const request = pending.find((item) => item.id === id);
      if (!request) return;
      if (answer === "deny") {
        const { deny } = waiting.get(id) ?? {};
        remove(id);
        deny?.(
          new Error(
            `Your owner denied ${request.tool}: ${request.title}. Do not retry it unless they ask.`,
          ),
        );
        return;
      }
      if (answer === "always") {
        // A save that fails still allows this call; the next one asks again.
        void storage
          .set(allowedKey(request), "1")
          .catch((error) =>
            console.warn("Could not remember a plugin tool approval", error),
          );
        // Calls waiting on the same tool have been answered too.
        for (const other of pending.filter(
          (item) =>
            item.plugin === request.plugin && item.tool === request.tool,
        )) {
          const { settle } = waiting.get(other.id) ?? {};
          remove(other.id);
          settle?.("always");
        }
        return;
      }
      const { settle } = waiting.get(id) ?? {};
      remove(id);
      settle?.("once");
    },
  };
}
