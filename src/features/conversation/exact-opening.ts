import type { ChannelWindow } from "../relay/contracts";

/** Where an exact message open shows its message. Only a top-level message
 * with no replies, found in a fresh window, stays in the channel timeline; a
 * root with replies opens its thread, whichever link form addressed it. A root
 * found in the window is its own thread root, so a link's `thread` hint cannot
 * select a different one. */
export function placeExactOpening(
  window: ChannelWindow,
  messageId: string,
): Readonly<{ inTimeline: boolean; rootId?: string }> {
  const root =
    window.status === "ready" && window.freshness !== "cached"
      ? window.rows.find((row) => row.id === messageId && !row.threadRootId)
      : undefined;
  return root
    ? { inTimeline: root.replyCount === 0, rootId: root.id }
    : { inTimeline: false };
}
