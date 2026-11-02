// Prompts in the harness's format (buzz-acp), so a Claude agent here reads the
// same sections and follows the same base prompt as a harness agent.
import { npubEncode } from "nostr-tools/nip19";
import {
  BUZZ_PROMPT,
  TOP_LEVEL_PROMPT,
  CHANNEL_LEVEL_PROMPT,
} from "../../buzz-mcp/prompt";
import type { EventData } from "../../features/relay/events";
import { BASE_PROMPT } from "../../features/agent-harness/base-prompt";
import { coreMemorySection } from "../../features/agent-harness/core-memory";
import {
  type ConversationWake,
  wakeSection,
} from "../../features/agent-harness/plugin-wake";
import channelModel from "./session_model_channel.md?raw";
import threadModel from "./session_model_thread.md?raw";

export type Scope = "thread" | "channel";
/** Messages of thread context shown with a turn, newest kept. */
export const CONTEXT_LIMIT = 12;

const section = (tag: string, body: string, attributes = "") =>
  `<${tag}${attributes}>\n${body.trim()}\n</${tag}>`;

export function systemPrompt(
  input: Readonly<{
    scope: Scope;
    cwd: string;
    /** Who the agent is, so it can name itself and the session viewer can too. */
    agent?: Readonly<{ name: string; pubkey: string }>;
    instructions?: string;
    /** Device-local repository location, supplied by the owning runtime. */
    repositories?: string;
    /** A section for each team the agent is on, from the host. */
    team?: string;
    /** The agent's `core` memory; `null` when it has none yet. */
    memory?: string | null;
  }>,
) {
  const model = input.scope === "thread" ? threadModel : channelModel;
  const base = [BASE_PROMPT, BUZZ_PROMPT, model];
  return [
    input.agent
      ? section(
          "identity",
          `You are ${input.agent.name} (pubkey ${input.agent.pubkey}).`,
        )
      : "",
    section("base", base.map((part) => part.trim()).join("\n\n")),
    section("workspace", `Current working directory: ${input.cwd}`),
    input.repositories ?? "",
    input.instructions?.trim()
      ? section("agent-instructions", input.instructions)
      : "",
    input.team?.trim() ?? "",
    coreMemorySection(input.memory),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type Channel = Readonly<{
  id: string;
  name?: string;
  dm?: boolean;
}>;
export type TurnInput = Readonly<{
  /** The agent's membership key, which finds its sessions among others' in a
   * shared workspace. */
  agent: string;
  event: EventData;
  channel: Channel;
  scope: Scope;
  /** One channel conversation, with a channel-level posting default. */
  topLevel?: boolean;
  /** Channel delivery permits explicit replies; Solo chats do not. */
  channelLevel?: boolean;
  /** The thread the event belongs to, absent for a top-level message. */
  thread?: Readonly<{ rootId: string; parentId: string }>;
  /** Messages of the conversation the session has not been shown: earlier
   * ones, and for a resumed turn also those after it. */
  context: readonly EventData[];
  /** Messages the conversation has in all, for `total=`. */
  total: number;
  /** What started the turn, such as "@mention". */
  label: string;
  /** A display name for a pubkey, if known. */
  name(pubkey: string): string | undefined;
  /** The chat's workspace Canvas section, for a Solo chat with one. */
  project?: string;
  /** A plugin's wake, whose turn has its section in place of the event's. */
  wake?: ConversationWake;
}>;

const time = (seconds: number) => new Date(seconds * 1000).toISOString();
const actor = (pubkey: string, name: TurnInput["name"]) => {
  const label = name(pubkey);
  return label ? `${label} (${pubkey})` : pubkey;
};

/** One turn: routing context, unseen thread context, then the event. */
export function turnPrompt(input: TurnInput) {
  const { event, channel, thread } = input;
  const channelLabel = channel.name
    ? `${channel.name} (#${channel.id})`
    : channel.id;
  // A session shared by a channel's threads (or a DM's) cannot tell which
  // thread a reply is for, so it names the thread itself.
  const root = thread?.rootId ?? event.id;
  const shared = channel.dm || input.scope === "channel";
  const reply = input.topLevel
    ? `IMPORTANT: ${input.channelLevel ? CHANNEL_LEVEL_PROMPT : TOP_LEVEL_PROMPT}`
    : shared
      ? `IMPORTANT: For ordinary replies in this turn, pass \`reply: "${root}"\` to \`send\` so the conversation stays threaded. Do NOT reply into any other (older) thread. If the human explicitly asks for a channel-root, top-level, or broadcast post, leave out \`reply\`.`
      : thread
        ? "IMPORTANT: `send` replies in this thread by default, so the conversation stays threaded. If the human explicitly asks for a channel-root, top-level, or broadcast post, pass `channel`. If the requested destination is ambiguous, ask before sending."
        : "IMPORTANT: This is a new top-level message. `send` replies in its thread by default — the triggering message is the thread root. Do NOT reply into any other (older) thread. If the human explicitly asks for a channel-root, top-level, or broadcast post, pass `channel`.";
  const fetch = input.topLevel
    ? "Use `read` for recent messages if needed."
    : shared
      ? thread
        ? `Use \`read\` with \`thread: "${root}"\` for full history if truncated.`
        : "Use `read` for recent messages if needed."
      : thread
        ? "Use `read` for full history if truncated."
        : "Use `read` with `channel` for recent messages if needed.";
  const context = input.context.slice(-CONTEXT_LIMIT);
  const hint = context.length
    ? `Thread context included below. ${fetch}`
    : input.total > 1
      ? `Earlier context is already available in this session. ${fetch}`
      : fetch;
  const lines = channel.dm
    ? [
        "Scope: dm",
        "Session scope: dm conversation",
        `Channel: ${channelLabel}`,
      ]
    : !input.topLevel && (thread || input.scope === "thread")
      ? [
          "Scope: thread",
          `Session scope: ${input.scope}`,
          `Channel: ${channelLabel}`,
          `Thread root: ${thread?.rootId ?? event.id}`,
          ...(thread && thread.parentId !== thread.rootId
            ? [`Parent: ${thread.parentId}`]
            : []),
        ]
      : [
          "Scope: channel",
          "Session scope: channel",
          `Channel: ${channelLabel}`,
        ];
  const parts = [
    section(
      "context",
      [...lines, `Agent: ${input.agent}`, hint, reply].join("\n"),
    ),
  ];
  if (input.project) parts.push(input.project);
  if (context.length)
    parts.push(
      section(
        (channel.dm && !thread) || input.topLevel
          ? "conversation-context"
          : "thread-context",
        context
          .map(
            (message, index) =>
              `[${index + 1}] ${actor(message.pubkey, input.name)} (${time(message.created_at)}): ${message.content}`,
          )
          .join("\n"),
        ` included="${context.length}" total="${input.total}" truncated="${context.length < input.context.length}"`,
      ),
    );
  parts.push(
    input.wake
      ? wakeSection(input.wake)
      : section("buzz-event", eventBlock(input), ` type="${input.label}"`),
  );
  return parts.join("\n\n");
}

function eventBlock({ event, channel, thread, name }: TurnInput) {
  const npub = npubEncode(event.pubkey);
  const label = name(event.pubkey);
  const mentions = event.tags
    .filter((tag) => tag[0] === "p" && tag[1])
    .map((tag) => actor(tag[1] as string, name));
  const parsed = [
    ...(thread && thread.parentId !== thread.rootId
      ? [`parent=${thread.parentId}`]
      : []),
    ...(thread ? [`root=${thread.rootId}`] : []),
    ...(mentions.length ? [`mentions=[${mentions.join(", ")}]`] : []),
  ];
  return [
    `Event ID: ${event.id}`,
    `Channel: ${channel.name ? `${channel.name} (#${channel.id})` : channel.id}`,
    `Kind: ${event.kind}`,
    `From: ${label ? `${label} (npub: ${npub}, hex: ${event.pubkey})` : `${npub} (hex: ${event.pubkey})`}`,
    `Time: ${time(event.created_at)}`,
    `Content: ${event.content}`,
    `Tags: ${JSON.stringify(event.tags)}`,
    ...(parsed.length ? [`Parsed: ${parsed.join(", ")}`] : []),
  ].join("\n");
}

/** A turn for a session that is still working on an earlier one. */
export const steerPrompt = (turn: string) =>
  `${section("new-message-arrived-while-you-were-working", turn)}\n\nNote: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.`;
