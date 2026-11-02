// The empty-name prompt shared by agent creation and the profile rename.
import { useReducedMotion } from "motion/react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Whether an element is fully visible inside its nearest scrolling ancestor. */
const inView = (element: HTMLElement) => {
  let scroller = element.parentElement;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY))
    scroller = scroller.parentElement;
  const box = element.getBoundingClientRect();
  const frame = scroller?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  };
  let top = frame.top;
  let bottom = frame.bottom;
  // Sticky bars paint over the scrollport without reducing its bounds.
  for (const child of scroller?.children ?? []) {
    const style = getComputedStyle(child);
    if (style.position !== "sticky") continue;
    const bar = child.getBoundingClientRect();
    if (style.top !== "auto") top = Math.max(top, bar.bottom);
    if (style.bottom !== "auto") bottom = Math.min(bottom, bar.top);
  }
  return box.top >= top && box.bottom <= bottom;
};

/**
 * Flags an empty name on submit instead of disabling the button. Each
 * `prompt` focuses the name, brings it into view, and bumps `attempts` so the
 * caller replays `useShake`; 0 means no prompt is shown.
 */
export function useNamePrompt(nameField: RefObject<HTMLInputElement | null>) {
  const [attempts, setAttempts] = useState(0);
  // The frame waiting for a scroll to land before showing the prompt.
  const pending = useRef(0);
  useEffect(() => () => cancelAnimationFrame(pending.current), []);
  const prompt = useCallback(() => {
    const field = nameField.current;
    if (!field || pending.current) return;
    field.focus({ preventScroll: true });
    const reveal = () => {
      pending.current = 0;
      if (!field.value.trim()) setAttempts((count) => count + 1);
    };
    if (inView(field)) {
      reveal();
      return;
    }
    // Center the name when there's room; scrolling stops at the top. The
    // prompt starts as the scroll eases into place, so the shake plays in
    // view without waiting out the scroll's slow tail.
    field.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    const started = performance.now();
    let last = Number.NaN;
    let gliding = false;
    const settle = () => {
      const top = field.getBoundingClientRect().top;
      const step = Math.abs(top - last);
      // Slow frames count only after the glide has sped up, not while it
      // eases in.
      const slowing = step === 0 || (gliding && step < 4);
      if (step >= 4) gliding = true;
      last = top;
      if ((slowing && inView(field)) || performance.now() - started > 1000)
        reveal();
      else pending.current = requestAnimationFrame(settle);
    };
    pending.current = requestAnimationFrame(settle);
  }, [nameField]);
  /** Clears the prompt once the name is filled in. */
  const named = useCallback((name: string) => {
    if (name.trim()) setAttempts(0);
  }, []);
  return { attempts, prompt, named };
}

/** A damped side-to-side shake, like a rejected iOS passcode, per attempt. */
export function useShake(
  target: RefObject<HTMLElement | null>,
  attempt: number | undefined,
) {
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!attempt || reducedMotion) return;
    target.current?.animate(
      [0, -10, 8, -6, 4, -2, 0].map((x) => ({
        transform: `translateX(${x}px)`,
      })),
      { duration: 400, easing: "ease-out" },
    );
  }, [target, attempt, reducedMotion]);
}
