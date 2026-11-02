import { useEffect, useRef, type RefObject } from "react";
import { highlightWhenSettled } from "./message-highlight";

/** A close-time orientation cue, not a reveal request or a scroll owner. */
export function useReturnHighlight(
  conversation: RefObject<HTMLElement | null>,
  channelId: string | undefined,
) {
  const pending = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: a channel change retires the prior channel's pending or painted cue.
  useEffect(() => () => pending.current(), [channelId]);
  return (messageId: string | undefined) => {
    pending.current();
    if (!messageId) return;
    let clear = () => {};
    // Let tab selection and the current close/navigation commit settle first.
    // Check once: hidden and unloaded roots get no deferred cue.
    const frame = requestAnimationFrame(() => {
      const container = conversation.current;
      if (
        !container?.isConnected ||
        container.closest('[inert], [hidden], [aria-hidden="true"]')
      )
        return;
      const scroller = container.querySelector<HTMLElement>(
        "[data-channel-timeline]",
      );
      if (!scroller || scroller.dataset.channelTimeline !== channelId) return;
      clear = highlightWhenSettled(scroller, messageId);
    });
    pending.current = () => {
      cancelAnimationFrame(frame);
      clear();
    };
  };
}
