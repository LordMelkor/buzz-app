import type { RelayEvent } from "./events";
/** Verified live-route message only. Not an activity feed, replay, or read intent. */
export type IncomingMessage = Readonly<{
  channelId: string;
  messageId: string;
  createdAt: number;
  authorId: string;
  /** The displayed author: `authorId` unless the community's relay signed on
   * someone's behalf (`actor` or a leading `p`). */
  displayAuthorId?: string | undefined;
  workflowOwnerId?: string | undefined;
  /** At most 4,096 source characters for a preview, not the complete message. */
  previewContent: string;
  /** Signed `audience` tag: `agents` is coordination between agents. */
  audience?: "agents";
}>;
export type IncomingListener = (messages: readonly IncomingMessage[]) => void;
/** Verified events from one delivery. `channelId` is the route's channel
 * when the wire scope was unambiguous; global routes (profiles, #p hints) omit it.
 * `replay` marks the recent history a subscription sends before it goes live,
 * as after a reconnect; it reaches only listeners that asked for it. */
export type LiveBatch = Readonly<{
  events: readonly RelayEvent[];
  channelId?: string;
  replay?: true;
}>;
export type LiveListener = (batch: LiveBatch) => void;
