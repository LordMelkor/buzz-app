import { invoke, isTauri } from "@tauri-apps/api/core";

/** Copies plain text. The macOS app has the host write it: WebKit rejects a
 * `navigator.clipboard` write without transient user activation, and every
 * host script evaluation (how Tauri delivers events and channel messages)
 * clears that activation, so a click racing host traffic would fail to copy. */
export function writeClipboardText(text: string): Promise<void> {
  return isTauri() && /Mac/.test(navigator.platform)
    ? invoke("clipboard_write_text", { text })
    : navigator.clipboard.writeText(text);
}
