// Host contribution types the plugin author API does not export by name.
import type { Conversation } from "../../../plugins/author";

export type CodeBlockRenderer = Parameters<
  Conversation["registerCodeBlock"]
>[0];
export type InlineRenderer = Parameters<Conversation["registerInline"]>[0];
export type ComposerTool = Parameters<Conversation["registerTool"]>[0];
export type ComposerCompletion = Parameters<
  Conversation["registerCompletion"]
>[0];
