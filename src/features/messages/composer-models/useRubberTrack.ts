import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { animate, useReducedMotion } from "motion/react";

// Only the visual track stretches. Base UI keeps ownership of value, focus,
// pointer capture and the untransformed control's hit-testing geometry.
export function useRubberTrack(disabled: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const drag = useRef<{
    id: number;
    left: number;
    right: number;
    offset: number;
  } | null>(null);
  const geometry = useRef({ width: 1, limit: 26 });
  const amount = useRef(0);
  const spring = useRef<{ stop(): void } | null>(null);
  const paint = useCallback((stretch: number) => {
    amount.current = stretch;
    if (label.current)
      label.current.style.transform =
        stretch === 0
          ? ""
          : `translateX(${stretch * 0.5}px) rotate(${(stretch / geometry.current.limit) * 2.5}deg)`;
    const node = track.current;
    if (!node) return;
    const { width, limit } = geometry.current;
    node.style.transform =
      stretch === 0
        ? ""
        : `translateX(${stretch / 2}px) scale(${1 + Math.abs(stretch) / width}, ${1 - (0.07 * Math.abs(stretch)) / limit})`;
  }, []);
  const reset = useCallback(
    (immediate = false) => {
      drag.current = null;
      spring.current?.stop();
      if (immediate || reducedMotion || !amount.current) paint(0);
      else
        spring.current = animate(amount.current, 0, {
          type: "spring",
          stiffness: 420,
          damping: 25,
          mass: 0.65,
          onUpdate: paint,
          onComplete: () => paint(0),
        });
    },
    [paint, reducedMotion],
  );
  useEffect(() => {
    // Cancellation must also recover when the window loses the gesture.
    if (disabled) reset(true);
    const cancel = () => reset(true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      spring.current?.stop();
      drag.current = null;
      paint(0);
    };
  }, [disabled, paint, reset]);
  return {
    track,
    label,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (!event.isPrimary || drag.current) {
          event.preventDefault();
          return;
        }
        if (disabled || reducedMotion || event.button !== 0) return;
        spring.current?.stop();
        const rect = event.currentTarget.getBoundingClientRect();
        const thumb = event.currentTarget.querySelector<HTMLElement>(
          "[data-rubber-thumb]",
        );
        const thumbRect = thumb?.getBoundingClientRect();
        const half = (thumb?.offsetWidth ?? 40) / 2;
        const onThumb = thumb?.contains(event.target as Node);
        const popup = event.currentTarget.closest("[data-agent-model-card]");
        const padding = popup ? getComputedStyle(popup) : null;
        // Leave room for the lifted thumb inside the popover's clipped surface.
        const room = padding
          ? Math.min(
              Number.parseFloat(padding.paddingLeft),
              Number.parseFloat(padding.paddingRight),
            ) - 4
          : 4;
        geometry.current = {
          width: Math.max(1, rect.width),
          limit: Math.max(1, Math.min(26, rect.width * 0.08, room)),
        };
        drag.current = {
          id: event.pointerId,
          left: rect.left + half,
          right: rect.right - half,
          offset:
            onThumb && thumbRect
              ? event.clientX - (thumbRect.left + thumbRect.width / 2)
              : 0,
        };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const active = drag.current;
        if (!active || event.pointerId !== active.id) return;
        if (!event.buttons) {
          reset();
          return;
        }
        const x = event.clientX - active.offset;
        const excess =
          x < active.left
            ? x - active.left
            : x > active.right
              ? x - active.right
              : 0;
        const { limit } = geometry.current;
        paint(
          Math.sign(excess) *
            limit *
            (1 - Math.exp((-Math.abs(excess) * 0.55) / limit)),
        );
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        if (event.pointerId === drag.current?.id) reset();
      },
      onPointerCancel(event: PointerEvent<HTMLDivElement>) {
        if (event.pointerId === drag.current?.id) reset();
      },
      onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
        if (event.pointerId === drag.current?.id) reset();
      },
      onKeyDown() {
        reset(true);
      },
    },
  };
}
