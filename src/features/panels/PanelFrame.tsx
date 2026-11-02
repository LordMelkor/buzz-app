import type { ReactNode } from "react";
import { usePanelSplit } from "./usePanelSplit";
import { PanelDock } from "./PanelDock";
import styles from "./Panels.module.css";

// Keep this frame mounted even while closed: changing ancestry resets page state.
export function PanelFrame({
  companion,
  children,
}: {
  companion?: ReactNode;
  children: ReactNode;
}) {
  const split = usePanelSplit(420, 300);
  return (
    <div
      ref={split.ref}
      style={split.style}
      className={`${styles.frame} ${styles.splitMotion}`}
    >
      <div className={styles.page}>{children}</div>
      <PanelDock
        open={!!companion}
        className={styles.dock}
        resizeHandle={split.handle}
      >
        {companion}
      </PanelDock>
    </div>
  );
}
