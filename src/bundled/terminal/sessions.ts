import type { ChannelPanelContext } from "../../features/panels/service";
import type { TerminalBridge } from "./bridge";
import type { TerminalInputSource, TerminalScreen } from "./renderer";
import { nip19 } from "nostr-tools";

export type TerminalSession = {
  context: ChannelPanelContext;
  status: "starting" | "running" | "exited" | "error" | "ended";
  error?: string;
  id?: string;
  screen?: TerminalScreen;
};
type ScreenFactory = (
  input: (data: string, source: TerminalInputSource) => void,
  resize: (cols: number, rows: number) => void,
) => TerminalScreen;
const sessionKey = (context: ChannelPanelContext) =>
  JSON.stringify([context.scope, context.channelId]);
/** Plugin-owned lifetime, independent of drawer mounts. */
export function createSessions(
  bridge: TerminalBridge,
  loadScreen: () => Promise<ScreenFactory>,
  current: () => { scope?: string; viewer?: string; status: string },
) {
  const sessions = new Map<string, TerminalSession>();
  const listeners = new Set<() => void>();
  const initialized = new Set<string>();
  const retired = new WeakSet<TerminalSession>();
  let version = 0;
  let disposed = false;
  let owner: Promise<string> | undefined;
  const tasks = new Set<Promise<unknown>>();
  const notify = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const track = <T>(task: Promise<T>) => {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  };
  const live = (entry: TerminalSession) =>
    !disposed &&
    sessions.get(sessionKey(entry.context)) === entry &&
    !retired.has(entry) &&
    entry.status !== "ended";
  const allowed = (context: ChannelPanelContext) => {
    const snapshot = current();
    return (
      !disposed &&
      snapshot.status === "ready" &&
      snapshot.scope === context.scope &&
      snapshot.viewer === context.viewer
    );
  };
  const fail = (entry: TerminalSession, error: unknown) => {
    if (!live(entry)) return;
    entry.error = String(error);
    entry.status = "error";
    notify();
  };
  async function start(entry: TerminalSession) {
    try {
      owner ??= bridge.createOwner().catch((error) => {
        owner = undefined;
        throw error;
      });
      const [token, factory] = await Promise.all([owner, loadScreen()]);
      if (!live(entry) || !allowed(entry.context)) {
        if (live(entry)) {
          entry.status = "ended";
          notify();
        }
        return;
      }
      const { scope: _scope, viewer, ...context } = entry.context;
      const id = await bridge.spawn(
        token,
        { ...context, npub: nip19.npubEncode(viewer) },
        80,
        24,
      );
      entry.id = id;
      if (!live(entry) || !allowed(entry.context)) {
        await bridge.close(token, id);
        if (live(entry)) {
          entry.status = "ended";
          notify();
        }
        return;
      }
      let pendingBytes = 0;
      let writes = Promise.resolve();
      // Input usually produces echo; poll for it now instead of after the idle delay.
      let wake = () => {};
      let dimensions: [number, number] | undefined;
      let resizing = false;
      entry.screen = factory(
        (data, source) => {
          // User intent belongs to the selected scope; emulator replies belong
          // to the retained PTY even while another community is selected.
          const permitted = () => source === "reply" || allowed(entry.context);
          if (!live(entry) || !permitted() || entry.status !== "running")
            return;
          const bytes = new TextEncoder().encode(data).length;
          if (pendingBytes + bytes > 1024 * 1024) {
            fail(
              entry,
              "Terminal input is full. End this session and start again.",
            );
            return;
          }
          pendingBytes += bytes;
          writes = writes
            .then(async () => {
              try {
                if (live(entry) && permitted() && entry.status === "running") {
                  await bridge.write(token, id, data);
                  wake();
                }
              } finally {
                pendingBytes -= bytes;
              }
            })
            .catch((error) => fail(entry, error));
        },
        (cols, rows) => {
          dimensions = [
            Math.max(2, Math.min(500, cols)),
            Math.max(1, Math.min(300, rows)),
          ];
          if (resizing) return;
          resizing = true;
          void track(
            (async () => {
              try {
                while (
                  dimensions &&
                  live(entry) &&
                  entry.status === "running"
                ) {
                  const next = dimensions;
                  dimensions = undefined;
                  await bridge.resize(token, id, ...next);
                }
              } catch (error) {
                fail(entry, error);
              } finally {
                resizing = false;
              }
            })(),
          );
        },
      );
      entry.status = "running";
      notify();
      while (live(entry) && entry.status === "running") {
        // Armed before reading, so input written during the read still counts.
        const woken = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const result = await bridge.read(token, id);
        if (!live(entry)) break;
        if (result.data.length) await entry.screen.output(result.data);
        if (!live(entry) || entry.status !== "running") break;
        if (result.exited) {
          await bridge.close(token, id);
          if (!live(entry)) break;
          delete entry.id;
          entry.status = "exited";
          notify();
          break;
        }
        await Promise.race([
          woken,
          new Promise((resolve) =>
            setTimeout(resolve, result.data.length ? 0 : 40),
          ),
        ]);
      }
    } catch (error) {
      fail(entry, error);
    }
  }
  return {
    available: bridge.available,
    snapshot: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (context: ChannelPanelContext) => sessions.get(sessionKey(context)),
    ensure(context: ChannelPanelContext, initial = false) {
      const key = sessionKey(context);
      const existing = sessions.get(key);
      if (existing) return existing;
      // Restoring a panel is not intent to restart an explicitly ended shell.
      if (initial && initialized.has(key)) return;
      if (!bridge.available || !allowed(context)) return;
      if (sessions.size >= 20)
        throw new Error(
          "Twenty terminal sessions are open. End one before opening another.",
        );
      const entry: TerminalSession = {
        context: Object.freeze({ ...context }),
        status: "starting",
      };
      initialized.add(key);
      sessions.set(key, entry);
      notify();
      void track(start(entry));
      return entry;
    },
    async end(context: ChannelPanelContext) {
      const entry = sessions.get(sessionKey(context));
      if (!entry) return;
      retired.add(entry);
      entry.status = "ended";
      entry.screen?.dispose();
      delete entry.screen;
      notify();
      try {
        if (entry.id && owner) await bridge.close(await owner, entry.id);
        if (sessions.get(sessionKey(context)) === entry)
          sessions.delete(sessionKey(context));
      } catch (error) {
        entry.status = "error";
        entry.error = String(error);
        throw error;
      } finally {
        notify();
      }
    },
    async dispose() {
      disposed = true;
      for (const entry of sessions.values()) entry.screen?.dispose();
      listeners.clear();
      // Closing the native owner fences pending spawns, even across IPC reordering.
      if (owner) await bridge.closeOwner(await owner);
      await Promise.allSettled([...tasks]);
      sessions.clear();
      initialized.clear();
    },
  };
}
export type TerminalSessions = ReturnType<typeof createSessions>;
