// Real startup owner with deferred, in-memory IPC. No native host or relay.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { App } from "../../src/app/App";
import type { AppServices } from "../../src/app/services";
import { createIdentity } from "../../src/features/identity/service";
import "../../src/shared/styles/globals.css";

declare global {
  interface Window {
    windowChrome: { calls: string[]; restore(): void };
  }
}
const calls: string[] = [];
let restore!: () => void;
const restored = new Promise<null>((resolve) => {
  restore = () => resolve(null);
});
mockWindows("main");
mockIPC((command) => {
  calls.push(command);
  if (command === "identity_restore") return restored;
  if (command === "identity_legacy_available") return false;
  if (command.startsWith("plugin:window|")) return;
  throw new Error(`Unexpected fixture command: ${command}`);
});
window.windowChrome = { calls, restore };
const identity = createIdentity();
const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
// This fixture stops at the real missing-identity screen, before ConnectedApp.
createRoot(root).render(
  <StrictMode>
    <App services={{ identity } as AppServices} />
  </StrictMode>,
);
