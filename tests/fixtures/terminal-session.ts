import "../../src/shared/styles/globals.css";
import { createSessions } from "../../src/bundled/terminal/sessions";
import { createScreen } from "../../src/bundled/terminal/renderer";
import type { TerminalInputSource } from "../../src/bundled/terminal/renderer";
import type { TerminalBridge } from "../../src/bundled/terminal/bridge";
import type { ChannelPanelContext } from "../../src/features/panels/service";

const context: ChannelPanelContext = {
  scope: "community-a",
  viewer: "ab".repeat(32),
  channelId: "retained-terminal",
  channelName: "Retained",
  relayUrl: "wss://example.invalid",
};
let selected = context.scope;
let serial = 0;
let releaseWrite: (() => void) | undefined;
let writing: Promise<void> | undefined;
const writes: { owner: string; id: string; data: string }[] = [];
const generated: { data: string; source: TerminalInputSource }[] = [];
const readers = new Map<
  string,
  (result: { data: Uint8Array; exited: boolean }) => void
>();
const bridge: TerminalBridge = {
  available: true,
  createOwner: async () => "retained-owner",
  spawn: async () => `pty-${++serial}`,
  read: async (_owner, id) =>
    new Promise((resolve) => readers.set(id, resolve)),
  write: async (owner, id, data) => {
    writes.push({ owner, id, data });
    await writing;
  },
  resize: async () => {},
  close: async (_owner, id) => {
    readers.get(id)?.({ data: new Uint8Array(), exited: true });
    readers.delete(id);
  },
  closeOwner: async () => {
    for (const resolve of readers.values())
      resolve({ data: new Uint8Array(), exited: true });
    readers.clear();
  },
};
const sessions = createSessions(
  bridge,
  async () => (input, resize) =>
    createScreen((data, source) => {
      generated.push({ data, source });
      input(data, source);
    }, resize),
  () => ({ scope: selected, viewer: context.viewer, status: "ready" }),
);
const host = document.getElementById("root");
if (!host) throw new Error("Missing host");
let detach: (() => void) | undefined;
let textarea: HTMLTextAreaElement | undefined;
const api = {
  writes,
  generated,
  ready: () => sessions.get(context)?.status === "running",
  reading: () => readers.has("pty-1"),
  mount() {
    detach = sessions.get(context)?.screen?.mount(host);
    textarea = host.querySelector("textarea") ?? undefined;
  },
  detach: () => detach?.(),
  switchScope: () => {
    selected = "community-b";
  },
  restoreScope: () => {
    selected = context.scope;
  },
  output(data: string) {
    const resolve = readers.get("pty-1");
    if (!resolve) throw new Error("No pending PTY read");
    readers.delete("pty-1");
    resolve({ data: new TextEncoder().encode(data), exited: false });
  },
  holdWrites() {
    writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
  },
  releaseWrites() {
    releaseWrite?.();
    writing = undefined;
  },
  staleInput() {
    if (!textarea) throw new Error("No retained textarea");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        keyCode: 88,
        bubbles: true,
        cancelable: true,
      }),
    );
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "STALE_PASTE");
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  },
  end: () => sessions.end(context),
  dispose: () => sessions.dispose(),
};
Object.assign(window, { terminalSession: api });
sessions.ensure(context);
