// The Buzz tools' guidance, which every agent plugin gives its agents after
// the shared base prompt (features/agent-harness): the posting conventions.
// How to use the attention tools is in their descriptions, so this never
// changes with the owner's attention setting.
import buzzPrompt from "./prompt.md?raw";

export const BUZZ_HELP_PROMPT =
  "When someone asks how to use Buzz, read buzz_help for product guidance bundled with this version. Check available tools and context before promising a capability.";

export const BUZZ_PROMPT = `${buzzPrompt.trim()}\n\n## Product help\n\n${BUZZ_HELP_PROMPT}`;

/** The turn instruction for a conversation whose messages stay at the
 * channel's top level; the tools refuse a reply into a thread there. */
export const TOP_LEVEL_PROMPT =
  "This is a continuous personal chat in the current channel. Continue this channel's conversation. Post progress, results and failures at the channel top level: use the current channel and omit `reply`; do not start or continue a thread here. Destinations you are explicitly asked to use elsewhere keep their own routing.";

/** The note on a turn given again after closing or reloading the app stopped
 * it partway. */
export const RESUMED_PROMPT =
  "Note: The app closed or reloaded while you were working on this message and stopped your turn partway. Carry on where you left off: check what this session and the conversation show you already did, and do not redo finished work or repeat messages you already sent.";

/** A subscription names a channel conversation, with reporting policy in its Interest. */
export const CHANNEL_LEVEL_PROMPT =
  "This wake is delivered at channel level. Post here without reply unless the Interest instructions direct a different channel or thread. The delivery address selects this execution conversation and the default posting destination; explicit reporting instructions in the Interest take precedence. The address grants no additional permission.";
