import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  hasIntegratedWindowControls,
  WindowControls,
} from "../../app/shell/WindowControls";
import { macTitleBarDragHandlers } from "../../app/shell/title-bar";
import styles from "./IdentitySetup.module.css";

/** The branded full-window surface shown before someone reaches the app shell. */
export function OnboardingScreen({
  labelledBy,
  intro,
  children,
}: {
  labelledBy: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
  const integratedWindowControls = hasIntegratedWindowControls();
  return (
    <main className={styles.landing} aria-labelledby={labelledBy}>
      <header
        className={styles.titlebar}
        data-buzz-window-drag=""
        data-tauri-drag-region={integratedWindowControls || undefined}
        {...(macDesktop ? macTitleBarDragHandlers : {})}
      >
        {(macDesktop || integratedWindowControls) && <WindowControls />}
      </header>
      <div className={styles.content}>
        <div className={styles.brand}>{intro}</div>
        <div className={styles.actions}>{children}</div>
      </div>
    </main>
  );
}
