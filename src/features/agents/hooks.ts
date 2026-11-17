import { withTimeout } from "../../plugins/timeout";
import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import { threadReference } from "../relay/thread-reference";
import type { Delivery, Trigger } from "./service";

/** Trusted routing supplied by the harness adapter, never by hook input.
 * `direct` and `conversation` come from the turn the event belongs to, and
 * only when core delivered that turn to the agent: absent, nothing says who
 * started it. */
export type AgentHookContext = Readonly<{
  agent: string;
  session: string;
  /** The owner's own signed message started the turn, and every request the
   * turn took since was one too. */
  direct?: boolean;
  /** Where the turn's trigger came from; `message`: the event that started it. */
  conversation?: Readonly<{ channel: string; root?: string; message?: string }>;
}>;
/** What an adapter passes when it dispatches: the routing, and the turn it
 * says the event belongs to, which core checks before plugins see it. */
export type AgentHookRouting = Readonly<{
  agent: string;
  session: string;
  turn?: Pick<Delivery, "trigger">;
}>;

/** Whether `trigger` is the owner's own signed message. A wake, a watch and an
 * attested sibling's message are not. */
export const directTrigger = (trigger: Trigger, owner: string | undefined) =>
  trigger.type === "mention" && !!owner && trigger.event.pubkey === owner;
/** The conversation a trigger came from, when it names one. */
export function conversationOf(
  trigger: Trigger,
): AgentHookContext["conversation"] {
  if ("channel" in trigger)
    return {
      channel: trigger.channel,
      ...(trigger.root && { root: trigger.root }),
    };
  if (!("event" in trigger)) return undefined;
  const channel = trigger.event.tags.find((tag) => tag[0] === "h")?.[1];
  const root = threadReference(trigger.event)?.rootId;
  return channel
    ? { channel, ...(root && { root }), message: trigger.event.id }
    : undefined;
}
/** Event names, input and output formats belong to the selected agent type. */
export type AgentHook = Readonly<{
  id: string;
  harness: string;
  event: string;
  run(input: unknown, context: AgentHookContext): unknown | Promise<unknown>;
}>;

export function createAgentHooks(root: Context) {
  const contributions = createContributions<AgentHook>(root);
  return {
    register(ctx: Context, hook: AgentHook) {
      if (!ctx.pluginOwner?.agentHooks?.includes(hook.harness))
        throw new Error(`Declare host.agentHooks access for ${hook.harness}`);
      if (!hook.event.trim() || typeof hook.run !== "function")
        throw new Error("A hook needs an event and callback");
      contributions.register(ctx, hook);
    },
    validate(
      types: readonly {
        key: string;
        hooks?: Readonly<{ events: readonly string[] }>;
      }[],
    ) {
      for (const hook of contributions.snapshot()) {
        const type = types.find((type) => type.key === hook.harness);
        if (type && !type.hooks?.events.includes(hook.event))
          console.warn(
            "Unsupported agent hook",
            hook.key,
            hook.harness,
            hook.event,
          );
      }
    },
    /** Adapters compose results in their own native format. Look up handlers on
     * every event so enabling or removing a plugin needs no process restart. */
    handlers(harness: string, event: string) {
      return contributions
        .snapshot()
        .filter((hook) => hook.harness === harness && hook.event === event)
        .sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

export type AgentHookDispatchOptions = Readonly<{
  accepts(output: unknown): boolean;
  milliseconds: number;
  /** Label native output using the registered owner, independently of payload. */
  compose?(output: unknown, pluginId: string): unknown;
}>;

/** Adapters supply native response acceptance and an event-wide time budget. */
export function dispatchAgentHooks(
  hooks: readonly (AgentHook & { pluginId: string })[],
  input: unknown,
  context: AgentHookContext,
  accepts: (output: unknown) => boolean,
  milliseconds: number,
  compose?: AgentHookDispatchOptions["compose"],
): Promise<unknown> {
  const deadline = Date.now() + milliseconds;
  const message = "Agent hook dispatch timed out";
  return withTimeout(
    (async () => {
      const errors: unknown[] = [];
      for (const hook of hooks) {
        if (Date.now() >= deadline) throw new Error(message);
        try {
          const output = await hook.run(input, context);
          if (accepts(output))
            return compose ? compose(output, hook.pluginId) : output;
        } catch (error) {
          console.warn("Agent hook failed", hook.id, error);
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
      return undefined;
    })(),
    message,
    milliseconds,
  );
}
