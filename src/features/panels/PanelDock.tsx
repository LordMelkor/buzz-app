import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Panels.module.css";

/** Layout owns overlay breakpoints; CSS owns motion and input preferences.
 * Retain closing content only until its own transitions finish, without timers.
 * Selection, focus restoration, and page lifetime remain with the callers. */
export function PanelDock({
  open,
  className,
  children,
  resizeHandle,
  keepMounted = false,
}: {
  open: boolean;
  className: string | undefined;
  children: ReactNode;
  resizeHandle?: ReactNode;
  /** A collapsible workspace keeps its tab contents and local view state. */
  keepMounted?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open ? { children } : null);
  if (
    (open || (keepMounted && retained)) &&
    (!retained || retained.children !== children)
  )
    setRetained({ children });

  useLayoutEffect(() => {
    if (open || !retained) return;
    const animations = [
      ...(element.current?.getAnimations?.() ?? []),
      ...(element.current?.parentElement?.getAnimations?.() ?? []),
    ];
    if (!animations.length) {
      setRetained(null);
      return;
    }
    let cancelled = false;
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => {
      if (!cancelled) setRetained(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, retained]);

  if (!open && !retained && !keepMounted) return null;
  return (
    <div
      ref={element}
      style={!open && !retained ? { display: "none" } : undefined}
      className={`${styles.motion} ${className ?? ""}`}
      data-panel-dock=""
      hidden={!open && !retained}
      data-closing={!open || undefined}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      {open && resizeHandle}
      {open || keepMounted ? children : retained?.children}
    </div>
  );
}
