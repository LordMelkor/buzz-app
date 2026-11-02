import { useSyncExternalStore } from "react";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import { ConversationChannel, ConversationThread } from "./Conversation";
import type { ConversationHostServices } from "./ConversationHost";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
>;
type Props = EmbeddedThreadProps & {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/** Channel visits and recovery span threads; overlays belong to one thread. */
export function EmbeddedThread({
  session,
  scope,
  channelId,
  channelName,
  messageId,
  host,
  extensions,
}: Props) {
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = channels.find((item) => item.id === channelId);
  return (
    <ConversationChannel
      key={messageViewKey(session, scope, channelId)}
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      threadId={messageId}
      channel={{
        id: channelId,
        name: channelName,
        channelType: channel?.channelType,
        creator: channel?.creator,
      }}
    >
      <ConversationThread messageId={messageId} />
    </ConversationChannel>
  );
}
