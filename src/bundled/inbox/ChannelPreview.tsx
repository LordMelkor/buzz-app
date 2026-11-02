import { useEffect, useState } from "react";
import type { MessageComposerProps } from "../../features/messages/MessageComposer";
import {
  ConversationComposer,
  ConversationThread,
  ConversationTimeline,
  useConversation,
} from "../../features/conversation/Conversation";
import { placeExactOpening } from "../../features/conversation/exact-opening";
import { useChannelWindow } from "../../features/relay/react";
import { MessageEditScope } from "../../features/messages/MessageEditScope";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Inbox.module.css";

/** One selected conversation window and the same scoped composer used in Channels.
 * It preserves the canonical window and composer without owning a new reader. */
export function ChannelPreview({
  channelName,
  anchor,
  draft = false,
  onDraftSaved,
  label = "Conversation preview",
  autoFocus = false,
}: {
  /** The conversation's preview label, such as a DM's participants. */
  channelName: string;
  anchor?: string | undefined;
  draft?: boolean;
  onDraftSaved?: () => void;
  label?: string;
  /** Focus the composer when it mounts, as a user-triggered handoff. */
  autoFocus?: MessageComposerProps["autoFocus"];
}) {
  const { session, channelId } = useConversation();
  const window = useChannelWindow(session.channels, channelId);
  const [sentId, setSentId] = useState<string>();
  const [inlineSignal, setInlineSignal] = useState<AbortSignal>();
  useEffect(() => {
    if (!anchor) return;
    const request = new AbortController();
    setInlineSignal(request.signal);
    return () => request.abort();
  }, [anchor]);
  const [opening, setOpening] = useState<{
    anchor: string;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      !anchor ||
      opening?.anchor === anchor ||
      window.status === "idle" ||
      window.status === "loading"
    )
      return;
    // Same canonical decision as Channels: freeze this attempt after the head
    // settles; later live arrivals must not switch an exact reader's presentation.
    setOpening({
      anchor,
      inTimeline: placeExactOpening(window, anchor).inTimeline,
    });
  }, [anchor, opening, window]);
  const channel = session.channels.get?.(channelId);
  // Saved drafts open the current head without mutating canonical scroll intent.
  useEffect(() => {
    if (draft) session.channels.refresh?.(channelId);
  }, [session, channelId, draft]);
  // Cache clear can leave the selected window idle without remounting it.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  if (anchor && opening?.anchor === anchor && !opening.inTimeline)
    return (
      <ConversationThread
        channelName={channelName}
        messageId={anchor}
        revealSelected
      />
    );
  return (
    <MessageEditScope>
      <section
        className={styles.previewFrame}
        aria-label={label}
        data-reading-surface=""
      >
        <div className={styles.previewHistory}>
          {window.rows.length > 0 && (
            <ConversationTimeline
              window={window}
              {...(draft ? { transient: true } : {})}
              revealMessageId={sentId}
              inlineTarget={
                anchor && inlineSignal && !inlineSignal.aborted
                  ? { messageId: anchor, signal: inlineSignal }
                  : undefined
              }
            />
          )}
          {(window.status === "error" || window.error) && (
            <p className={styles.notice} role="alert">
              {window.error ?? "Could not load conversation."}
            </p>
          )}
          {(window.status === "error" || window.error) && (
            <div className={styles.notice}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => session.channels.refresh?.(channelId)}
              >
                Retry conversation
              </Button>
            </div>
          )}
          {window.status === "ready" &&
            !window.error &&
            !window.rows.length && (
              <div className={styles.empty} role="status">
                <EmptyState
                  icon={<ChatCircleIcon />}
                  title="No messages yet."
                  description="Start the conversation below."
                />
              </div>
            )}
          {(window.status === "idle" || window.status === "loading") &&
            !window.error &&
            !window.rows.length && (
              <p className={styles.notice} role="status">
                Loading conversation…
              </p>
            )}
        </div>
        <ConversationComposer
          channelName={channelName}
          label={
            channel?.channelType === "dm"
              ? `Message ${channelName}`
              : `Message #${channelName}`
          }
          onSend={setSentId}
          onDraftSaved={onDraftSaved}
          autoFocus={autoFocus}
        />
      </section>
    </MessageEditScope>
  );
}
