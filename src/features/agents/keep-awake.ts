import { useSyncExternalStore } from "react";

/** Off; Always ("on") while the app runs; or While agents work ("auto"): while
 * agents work and for `after` minutes once the last turn ends. */
export type KeepAwake = Readonly<{
  mode: "off" | "on" | "auto";
  after: number;
}>;
export const keepAwakeDelays = [30, 60, 120, 240, 480, 720] as const;

const preferenceKey = "buzz-keep-awake.v1";
const changedEvent = "buzz-keep-awake-changed";
const fallback: KeepAwake = Object.freeze({ mode: "off", after: 60 });
let saved: { raw: string | null; value: KeepAwake } | undefined;
let unsaved: KeepAwake | undefined;

export function keepAwakePreference(): KeepAwake {
  if (unsaved) return unsaved;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(preferenceKey);
  } catch {
    return fallback;
  }
  if (saved?.raw !== raw) saved = { raw, value: parse(raw) };
  return saved.value;
}
function parse(raw: string | null): KeepAwake {
  try {
    const { mode, after } = JSON.parse(raw ?? "null") ?? {};
    return Object.freeze({
      mode: mode === "on" || mode === "auto" ? mode : "off",
      after: keepAwakeDelays.includes(after) ? after : fallback.after,
    });
  } catch {
    return fallback;
  }
}
export function subscribeKeepAwake(listener: () => void) {
  // Hosts without a window (Node tests) have no other window to follow.
  if (typeof window === "undefined") return () => {};
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsaved = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useKeepAwakePreference() {
  return useSyncExternalStore(subscribeKeepAwake, keepAwakePreference);
}
/** Applies `value` at once; the error says when it could not be saved. */
export function setKeepAwakePreference(value: KeepAwake): string | null {
  let error: string | null = null;
  unsaved = Object.freeze({ ...value });
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(value));
    unsaved = undefined;
  } catch {
    error = "It works for now, but Buzz will forget it when it restarts.";
  }
  window.dispatchEvent(new Event(changedEvent));
  return error;
}

// What the host last failed to apply, so Settings can say so and retry.
let applyError: string | null = null;
let reapply: (() => void) | undefined;
const applyListeners = new Set<() => void>();
function setApplyError(next: string | null) {
  if (next === applyError) return;
  applyError = next;
  for (const listener of applyListeners) listener();
}
function subscribeApplyError(listener: () => void) {
  applyListeners.add(listener);
  return () => void applyListeners.delete(listener);
}
/** Why this Mac is not kept awake as chosen, or null when it is. */
export function useKeepAwakeApplyError() {
  return useSyncExternalStore(subscribeApplyError, () => applyError);
}
/** Asks the host again to apply the current choice. */
export function retryKeepAwake() {
  reapply?.();
}

/** Holds the native keep-awake assertion as the preference and agent work
 * ask. Choosing the setting or starting the app starts an Automatic wait as a
 * finished turn does. */
export function bindKeepAwake(
  agents: Readonly<{
    isWorking(): boolean;
    subscribeWorking(listener: () => void): () => void;
  }>,
  hold: (hold: boolean) => Promise<void>,
  preference: Readonly<{
    read(): KeepAwake;
    subscribe(listener: () => void): () => void;
  }> = { read: keepAwakePreference, subscribe: subscribeKeepAwake },
) {
  let current = preference.read();
  let idleSince = Date.now();
  let working = agents.isWorking();
  // Unknown at first: a reloaded page may find the host still holding.
  let held: boolean | undefined;
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    const wanted =
      current.mode === "on" ||
      (current.mode === "auto" &&
        (working || Date.now() < idleSince + current.after * 60_000));
    if (current.mode === "auto" && !working && wanted)
      timer = setTimeout(
        update,
        idleSince + current.after * 60_000 - Date.now(),
      );
    if (wanted === held) return;
    held = wanted;
    const id = ++request;
    hold(wanted).then(
      () => {
        if (id === request) setApplyError(null);
      },
      (error) => {
        console.warn("Couldn't change keeping this Mac awake", error);
        if (id !== request) return;
        // Unknown again, so the next change or a retry asks again.
        held = undefined;
        setApplyError(
          wanted
            ? "Couldn’t keep this Mac awake"
            : "Couldn’t let this Mac sleep again",
        );
      },
    );
  };
  const retry = () => {
    held = undefined;
    update();
  };
  reapply = retry;
  const stopPreference = preference.subscribe(() => {
    const next = preference.read();
    if (next.mode === current.mode && next.after === current.after) return;
    current = next;
    idleSince = Date.now();
    update();
  });
  const stopWorking = agents.subscribeWorking(() => {
    const next = agents.isWorking();
    if (next === working) return;
    working = next;
    if (!working) idleSince = Date.now();
    update();
  });
  update();
  return () => {
    stopPreference();
    stopWorking();
    clearTimeout(timer);
    request++;
    if (reapply === retry) {
      reapply = undefined;
      setApplyError(null);
    }
    if (held !== false) void hold(false).catch(() => {});
    held = false;
  };
}
