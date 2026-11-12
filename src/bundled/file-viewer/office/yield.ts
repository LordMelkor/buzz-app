import { checkAbort } from "./xml";

/** A task boundary lets input/cancellation run. The first boundary additionally
 * waits for a frame, then a task, so the host can paint its Opening state.
 * A bounded fallback also makes progress in hidden windows without frames.
 */
export function yieldOffice(signal: AbortSignal, paint = false): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let state: "pending" | "settled" = "pending";
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (aborted = false) => {
      if (state === "settled") return;
      state = "settled";
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener("abort", abort);
      if (aborted)
        reject(
          new DOMException("The caller aborted the office load", "AbortError"),
        );
      else resolve();
    };
    const abort = () => settle(true);
    const afterFrame = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(), 0);
    };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => settle(), paint ? 50 : 0);
    if (paint && typeof requestAnimationFrame === "function")
      frame = requestAnimationFrame(afterFrame);
  });
}

/** Small parts share a task; yield after a 12 ms work budget. A forced
 * boundary keeps the last DOM/projection step separate from SheetJS.read.
 */
export function officeBudget(
  signal: AbortSignal,
): (force?: boolean) => Promise<void> | undefined {
  let last = performance.now();
  return (force = false) => {
    checkAbort(signal);
    if (!force && performance.now() - last < 12) return;
    return yieldOffice(signal).then(() => {
      last = performance.now();
    });
  };
}
