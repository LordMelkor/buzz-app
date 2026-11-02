import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import styles from "./ResizeHandle.module.css";

export function ResizeHandle({
  width,
  setWidth,
  min,
  max,
  reset,
  label,
  className = "",
  direction = 1,
  target,
  property = "width",
}: {
  width: number;
  setWidth(width: number): void;
  min: number;
  max: number;
  reset(): void;
  label: string;
  className?: string | undefined;
  direction?: 1 | -1;
  target?: RefObject<HTMLElement | null>;
  property?: string;
}) {
  const handle = useRef<HTMLHRElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(width);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    next: number;
    moved?: boolean;
    style: CSSStyleDeclaration;
    previous: string;
    priority: string;
    frame?: number | undefined;
  }>(undefined);
  const resize = useRef({ setWidth, min, max, direction });
  resize.current = { setWidth, min, max, direction };
  const nextWidth = useCallback((event: PointerEvent) => {
    const active = drag.current;
    if (!active) return;
    active.moved ||= event.clientX !== active.startX;
    const { min, max, direction } = resize.current;
    active.next = Math.min(
      max,
      Math.max(
        min,
        Math.round(active.width + direction * (event.clientX - active.startX)),
      ),
    );
  }, []);
  const move = useCallback(
    (event: PointerEvent) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      nextWidth(event);
      // Preview layout locally; the page state and durable width change on release.
      active.frame ??= requestAnimationFrame(() => {
        active.frame = undefined;
        active.style.setProperty(property, `${active.next}px`);
      });
    },
    [nextWidth, property],
  );
  const finish = useCallback(
    (event?: Event) => {
      const active = drag.current;
      if (
        !active ||
        (event && "pointerId" in event && event.pointerId !== active.pointerId)
      )
        return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (active.frame !== undefined) cancelAnimationFrame(active.frame);
      if (active.previous)
        active.style.setProperty(property, active.previous, active.priority);
      else active.style.removeProperty(property);
      if (event?.type === "pointerup") {
        nextWidth(event as PointerEvent);
        if (active.moved) resize.current.setWidth(active.next);
      }
      drag.current = undefined;
      handle.current?.removeAttribute("data-resizing");
      delete document.documentElement.dataset.sidebarResizing;
      document.documentElement.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [move, nextWidth, property],
  );
  // Only aria-valuenow reads the rendered width, and it changes only when the
  // panel is laid out differently (drag, keyboard step, reset, CSS clamp,
  // container or window resize). Observe the panel rather than measuring on
  // every commit: the handle re-renders with each channel-list replacement and
  // a getBoundingClientRect there forces layout of the whole committed tree.
  useLayoutEffect(() => {
    const panel =
      direction === 1
        ? handle.current?.previousElementSibling
        : handle.current?.parentElement;
    if (!(panel instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      const next = Math.round(panel.getBoundingClientRect().width);
      setRenderedWidth((current) => (current === next ? current : next));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [direction]);
  useEffect(() => () => finish(), [finish]);

  return (
    <hr
      ref={handle}
      data-panel-resize={direction === -1 ? "" : undefined}
      className={`${styles.handle} ${className}`}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(renderedWidth)}
      tabIndex={0}
      data-tooltip="Drag to resize · Double-click to reset"
      onDoubleClick={reset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const panel =
          direction === 1
            ? event.currentTarget.previousElementSibling
            : event.currentTarget.parentElement;
        const currentWidth =
          panel instanceof HTMLElement
            ? panel.getBoundingClientRect().width
            : renderedWidth;
        if (event.key === "ArrowLeft")
          setWidth(currentWidth - direction * step);
        else if (event.key === "ArrowRight")
          setWidth(currentWidth + direction * step);
        else if (event.key === "Home") setWidth(min);
        else if (event.key === "End") setWidth(max);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          document.documentElement.dataset.sidebarResizing
        )
          return;
        event.preventDefault();
        const panel =
          direction === 1
            ? event.currentTarget.previousElementSibling
            : event.currentTarget.parentElement;
        const element = target?.current ?? panel;
        if (
          !(panel instanceof HTMLElement) ||
          !(element instanceof HTMLElement)
        )
          return;
        const width = panel.getBoundingClientRect().width;
        drag.current = {
          style: element.style,
          previous: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
          next: width,
          pointerId: event.pointerId,
          startX: event.clientX,
          width,
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        window.addEventListener("blur", finish);
        event.currentTarget.setAttribute("data-resizing", "");
        document.documentElement.dataset.sidebarResizing = "true";
        document.documentElement.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}
