import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { launchVisible, subscribeLaunch } from "../launch";
import { hasIntegratedWindowControls, WindowControls } from "./WindowControls";

/** The loading screen blocks app content, not the undecorated window's controls. */
export function LaunchWindowControls() {
  const loading = useSyncExternalStore(subscribeLaunch, launchVisible);
  return loading ? createPortal(<LoadingWindowHeader />, document.body) : null;
}

// Also used during a later local restore, after the parser overlay is gone.
export function LoadingWindowHeader() {
  if (!hasIntegratedWindowControls()) return null;
  return (
    <header
      data-buzz-window-drag=""
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[10001] flex h-12 items-center justify-end px-4"
    >
      <WindowControls />
    </header>
  );
}
