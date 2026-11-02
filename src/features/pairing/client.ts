import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../identity/service";
export type PairingStatus =
  | {
      phase:
        | "uncertain"
        | "expired"
        | "idle"
        | "connecting"
        | "transferring"
        | "cancelling"
        | "complete"
        | "cancelled";
    }
  | { phase: "qr"; svg: string; uri: string }
  | { phase: "code"; code: string }
  | { phase: "error"; message: string };
export type PairingNative = {
  account(): Promise<string>;
  start(id: string, viewer: string, community: string): Promise<void>;
  status(id: string): Promise<PairingStatus>;
  confirm(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  cancel(id: string): Promise<PairingStatus>;
};
export const nativePairing: PairingNative = {
  account: () => invoke("pairing_account"),
  start: (id, viewer, community) =>
    invoke("pairing_start", { id, viewer, community }),
  status: (id) => invoke("pairing_status", { id }),
  confirm: (id) => invoke("pairing_confirm", { id }),
  deny: (id) => invoke("pairing_deny", { id }),
  cancel: (id) => invoke("pairing_cancel", { id }),
};
export const pairingAvailable = nativeIdentityEnabled;

export function createPairingClient(native: PairingNative = nativePairing) {
  let state: PairingStatus = { phase: "idle" };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active:
    | {
        id: string;
        started: Promise<void>;
        deciding?: boolean;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let cleanup: Promise<PairingStatus | undefined> = Promise.resolve(undefined);
  function update(next: PairingStatus) {
    state = next;
    for (const listener of listeners) listener();
  }
  function stop() {
    const previous = active;
    active = undefined;
    if (previous) {
      clearTimeout(previous.timer);
      // A late start must finish registering before cancellation. Cleanup failures
      // remain visible and block a replacement instead of abandoning a live session.
      cleanup = previous.started
        .catch(() => {})
        .then(() => native.cancel(previous.id));
    }
    return cleanup;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(viewer: string, community: string) {
      const attempt = ++generation;
      update({ phase: "connecting" });
      try {
        await stop();
        if (attempt !== generation) return;
        const id = crypto.randomUUID();
        const session: NonNullable<typeof active> = {
          id,
          started: native.start(id, viewer, community),
        };
        active = session;
        await session.started;
        const poll = async () => {
          try {
            const status = await native.status(id);
            if (active !== session || attempt !== generation) return;
            if (
              !(
                (session.deciding ||
                  state.phase === "transferring" ||
                  state.phase === "cancelling") &&
                (status.phase === "code" || status.phase === "transferring")
              )
            )
              update(status);
            if (
              ["connecting", "qr", "code", "transferring"].includes(
                status.phase,
              )
            )
              active.timer = setTimeout(() => void poll(), 400);
          } catch {
            if (active !== session) return;
            const cancelledGeneration = generation + 1;
            await this.cancel();
            if (
              generation !== cancelledGeneration ||
              state.phase !== "cancelled"
            )
              return;
            update({
              phase: "error",
              message: "Couldn’t check pairing. Try again.",
            });
          }
        };
        if (active === session && attempt === generation) await poll();
      } catch (error) {
        if (attempt === generation)
          update({ phase: "error", message: String(error) });
      }
    },
    async decide(kind: "confirm" | "deny") {
      const session = active;
      if (!session || state.phase !== "code" || session.deciding) return;
      session.deciding = true;
      // Do not invent a new pairing operation while an abort is pending.
      update({ phase: kind === "confirm" ? "transferring" : "cancelling" });
      try {
        await native[kind](session.id);
      } catch (error) {
        if (active === session)
          update({ phase: "error", message: String(error) });
      } finally {
        session.deciding = false;
      }
    },
    async confirm() {
      return this.decide("confirm");
    },
    async deny() {
      return this.decide("deny");
    },
    async cancel(reset = false) {
      const attempt = ++generation;
      // Native reports whether the account may already have been sent.
      update({ phase: "cancelling" });
      const stopping = active;
      try {
        const outcome = await stop();
        if (attempt !== generation) return;
        // Without a live session, an earlier cleanup result is not this outcome.
        if (reset || !stopping || !outcome)
          update({ phase: reset ? "idle" : "cancelled" });
        else update(outcome);
      } catch {
        if (attempt === generation)
          update({
            phase: "error",
            message:
              "Couldn’t cancel pairing. Close this window before trying again.",
          });
      }
    },
  };
}
