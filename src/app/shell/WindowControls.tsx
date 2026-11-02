import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowsOutIcon,
  MinusIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";

declare global {
  interface Window {
    /** Native document-start policy; absent in browser previews. */
    __BUZZ_WINDOW_CONTROLS__?: { minimize: boolean; maximize: boolean };
  }
}

export function hasIntegratedWindowControls() {
  return isTauri() && /^(Linux|Win)/i.test(navigator.platform);
}

/** App-owned chrome shared by the shell and pre-identity screen. */
export function WindowControls() {
  const [error, setError] = useState<string>();
  if (!hasIntegratedWindowControls()) return null;
  const run = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch {
      setError("Window action failed. Try again.");
    }
  };
  return (
    <fieldset
      className="flex shrink-0 items-center gap-1"
      aria-label="Window controls"
    >
      {error && (
        <span role="alert" className="text-body-sm">
          {error}
        </span>
      )}
      {window.__BUZZ_WINDOW_CONTROLS__?.minimize !== false && (
        <IconButton
          hint="familiar"
          aria-label="Minimize window"
          title="Minimize window"
          size="toolbar"
          icon={<MinusIcon size={16} />}
          onClick={() => void run(() => getCurrentWindow().minimize())}
        />
      )}
      {window.__BUZZ_WINDOW_CONTROLS__?.maximize !== false && (
        <IconButton
          hint="familiar"
          aria-label="Maximize or restore window"
          title="Maximize or restore window"
          size="toolbar"
          icon={<ArrowsOutIcon size={16} />}
          onClick={() => void run(() => getCurrentWindow().toggleMaximize())}
        />
      )}
      <IconButton
        hint="familiar"
        aria-label="Close window"
        title="Close window"
        size="toolbar"
        icon={<XIcon size={16} />}
        onClick={() => void run(() => getCurrentWindow().close())}
      />
    </fieldset>
  );
}
