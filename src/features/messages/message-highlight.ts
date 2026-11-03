import styles from "./Messages.module.css";

/** The part of a `[data-message-id]` item the arrival cue paints: the message
 * itself, never its day divider. Each row type marks its own surface. */
export function messageHighlightSurface(item: HTMLElement): HTMLElement | null {
  return item.matches("[data-highlight-surface]")
    ? item
    : item.querySelector<HTMLElement>(":scope > [data-highlight-surface]");
}

/** Briefly mark a message so the reader can find where they arrived. The cue
 * paints on the surface itself or, when it has a filled bubble, on that
 * bubble. Returns a clear for an early retire. */
export function highlightMessage(item: HTMLElement): () => void {
  const surface = messageHighlightSurface(item);
  if (!surface) return () => {};
  const clear = () => {
    surface.classList.remove(styles.messageHighlight ?? "");
    surface.removeEventListener("animationend", finish);
  };
  const finish = (event: AnimationEvent) => {
    const target = event.target as Element;
    if (
      event.pseudoElement === "::after" &&
      (target === surface ||
        target.classList.contains(styles.messageBubble ?? ""))
    )
      clear();
  };
  // Restart the cue when the same message is reached again.
  clear();
  void surface.offsetWidth;
  surface.classList.add(styles.messageHighlight ?? "");
  surface.addEventListener("animationend", finish);
  return clear;
}

/** How long the arrived-at message must hold still before it is marked. */
export const HIGHLIGHT_QUIET_MS = 200;
/** A message that never settles is marked anyway after this long. */
export const HIGHLIGHT_MAX_WAIT_MS = 1500;

/** Whether any of `box` shows inside both `viewport` and the window. */
export function onScreen(box: DOMRect, viewport: DOMRect): boolean {
  return (
    box.height > 0 &&
    box.width > 0 &&
    box.bottom > Math.max(viewport.top, 0) &&
    box.top < Math.min(viewport.bottom, window.innerHeight) &&
    box.right > Math.max(viewport.left, 0) &&
    box.left < Math.min(viewport.right, window.innerWidth)
  );
}

/** Mark a message once it stops moving. Rows, media and panels around a fresh
 * arrival can shift it for a moment; a cue during that settle reads as a
 * glitch, so wait until the row and the list around it hold still. The row is found by id each frame, since a virtual list may remount
 * it, and is marked only if it is still on screen. Returns a clear that
 * cancels the wait or retires the cue. */
export function highlightWhenSettled(
  scroller: HTMLElement,
  messageId: string,
): () => void {
  let frame = 0;
  let clear = () => {};
  let start: number | undefined;
  let since = 0;
  let last = "";
  const tick = (now: number) => {
    if (!scroller.isConnected) return;
    start ??= now;
    const item = [
      ...scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((element) => element.dataset.messageId === messageId);
    const surface = item && messageHighlightSurface(item);
    const box = surface?.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    // Rows still loading around it change the list's height before they
    // visibly move it, so the list counts as part of "still".
    const place = box
      ? `${box.top - viewport.top}:${box.height}:${scroller.scrollHeight}`
      : "";
    if (place !== last) {
      last = place;
      since = now;
    }
    if (
      now - since < HIGHLIGHT_QUIET_MS &&
      now - start < HIGHLIGHT_MAX_WAIT_MS
    ) {
      frame = requestAnimationFrame(tick);
      return;
    }
    if (item && box && onScreen(box, viewport)) clear = highlightMessage(item);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    clear();
  };
}
