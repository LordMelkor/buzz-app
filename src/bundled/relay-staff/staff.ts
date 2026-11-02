import type {
  ProbeDto,
  RelayStaffBackend,
  StaffContext,
  StaffFailure,
} from "../../features/relay-staff/contract";
import { unsupported } from "../../features/relay-staff/contract";
import { createWrites, type Writes } from "./writes";

/** The selected community relay and the identity that would sign for it. */
export type StaffTarget = { relay: string; signer: string };

export type Access =
  | { state: "probing" }
  | { state: "authorized"; probe: ProbeDto }
  | { state: "denied" }
  | { state: "notAdminApi" }
  | { state: "unreachable"; failure: StaffFailure };

type Discovery = {
  relay: string;
  origin: string | null | "pending" | "error";
};

/**
 * Discovery and authorization for the selected relay. While Settings is open,
 * each signing context is probed once, so only staff see the entries; opening
 * Settings again re-probes. Access is remembered per (signer, origin).
 */
export function createStaff(
  backend: RelayStaffBackend,
  target: () => StaffTarget | null,
) {
  const listeners = new Set<() => void>();
  const access = new Map<string, Access>();
  const writes = new Map<string, Writes>();
  let discovery: Discovery | null = null;
  let retained = 0;
  let disposed = false;
  /** Contexts probed since Settings last opened. */
  const checked = new Set<string>();
  /** Latest probe per access key; an older one's result is dropped. */
  const attempts = new Map<string, number>();
  const probing = new Set<string>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  /** Latest discovery; an older one's answer is dropped. */
  let discovering = 0;
  /**
   * True while the latest discovery is out. Every automatic check waits for
   * it, so none is signed for a host the fresh answer may no longer name.
   */
  let looking = false;
  /**
   * Reads the relay's advertised admin host. `force` re-reads a relay already
   * known, keeping its current host on screen until the new answer lands, so
   * a changed or newly enabled admin API shows without a restart.
   */
  const discover = (force = false) => {
    if (disposed) return;
    const relay = target()?.relay ?? null;
    if (!backend.available || !relay) {
      discovering++;
      looking = false;
      if (discovery) {
        discovery = null;
        emit();
      }
      return;
    }
    const known = discovery?.relay === relay && discovery.origin !== "error";
    if (known && (!force || discovery?.origin === "pending")) return;
    const attempt = ++discovering;
    looking = true;
    if (known) emit();
    if (!known) {
      discovery = { relay, origin: "pending" };
      emit();
    }
    backend.discover(relay).then(
      (origin) => settle(attempt, relay, origin),
      () => settle(attempt, relay, "error"),
    );
  };
  const settle = (
    attempt: number,
    relay: string,
    origin: Discovery["origin"],
  ) => {
    if (disposed || attempt !== discovering) return;
    looking = false;
    if (discovery?.relay !== relay) return;
    if (discovery.origin !== origin) {
      discovery = { relay, origin };
    }
    check();
    emit();
  };

  /** The signing context for the selected relay, once discovery has an origin. */
  const context = (): StaffContext | null => {
    const now = target();
    const origin = discovery?.origin;
    if (!now || discovery?.relay !== now.relay || !origin) return null;
    if (origin === "pending" || origin === "error") return null;
    return { relay: now.relay, origin, signer: now.signer };
  };
  const key = (context: StaffContext) => `${context.signer} ${context.origin}`;
  const contextKey = () => {
    const now = context();
    return now && `${key(now)} ${now.relay}`;
  };

  /** The Settings check: one probe per context while Settings stays open. */
  const check = () => {
    const now = context();
    const id = contextKey();
    if (disposed || looking || !retained || !now || !id || checked.has(id))
      return;
    checked.add(id);
    void probe(now, true);
  };

  /** Settings visibility: shown only to staff of the advertised admin host. */
  const visible = (): boolean | "pending" | "error" => {
    const origin = discovery?.origin;
    if (!origin || origin === "pending") return origin ? "pending" : false;
    if (origin === "error") return "error";
    const now = context();
    const known = now && access.get(key(now));
    if (!known || known.state === "probing") return "pending";
    if (known.state === "authorized") return true;
    return known.state === "unreachable" ? "error" : false;
  };

  /**
   * Signed probe. Reuses a remembered result unless `force`; a forced
   * re-probe keeps the current result on screen until the new one lands.
   */
  const probe = async (context: StaffContext, force = false) => {
    if (disposed) return;
    const id = key(context);
    if (!force && access.has(id)) return;
    if (!access.has(id) || access.get(id)?.state !== "authorized") {
      access.set(id, { state: "probing" });
    }
    probing.add(id);
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    emit();
    const outcome = await backend.request(context, { route: "probe" });
    if (disposed || attempts.get(id) !== attempt) return;
    probing.delete(id);
    const next = toAccess(outcome);
    // An unchanged role keeps the same session, so its reads do not rerun.
    const previous = access.get(id);
    if (!sameAccess(previous, next)) access.set(id, next);
    emit();
  };

  return {
    backend,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visible,
    /** Enable requires a completed, current check, even while navigation retains its last result. */
    availability():
      | "allowed"
      | "checking"
      | "denied"
      | "error"
      | "unavailable" {
      if (!backend.available) return "unavailable";
      if (looking || !discovery || discovery.origin === "pending")
        return "checking";
      if (discovery.origin === "error") return "error";
      if (!discovery.origin) return "unavailable";
      const now = context();
      const known = now && access.get(key(now));
      if (!known || (now && probing.has(key(now))) || known.state === "probing")
        return "checking";
      if (known.state === "authorized") return "allowed";
      if (known.state === "unreachable") return "error";
      return known.state === "denied" ? "denied" : "unavailable";
    },
    retry() {
      checked.clear();
      discover(true);
    },
    dispose() {
      disposed = true;
      discovering++;
      listeners.clear();
    },
    /** The Staff entry: operators only. */
    operatorVisible(): boolean | "pending" | "error" {
      const shown = visible();
      if (shown !== true) return shown;
      const now = context();
      const known = now && access.get(key(now));
      return known?.state === "authorized" && known.probe.role === "operator";
    },
    ensure() {
      // Opening Settings re-reads the admin host and re-checks every
      // context, so a changed admin API or a demotion shows.
      const opening = retained++ === 0;
      if (opening) checked.clear();
      discover(opening);
      // While a re-read is out, its answer runs the check, for the host it names.
      check();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained--;
      };
    },
    /** Re-run discovery and the check when the relay or identity changes. */
    refresh() {
      if (retained) discover();
      // An identity switch on the same relay changes the context, not discovery.
      check();
      emit();
    },
    context,
    /** Snapshot that changes whenever the signer, admin host or relay does. */
    contextKey,
    /**
     * Writes for exactly this signer, admin host and relay. Kept in memory
     * for the app session, outside every view and authorization state, so a
     * held write is resent unchanged and never under another identity or host.
     */
    writes(context: StaffContext) {
      const id = `${key(context)} ${context.relay}`;
      let held = writes.get(id);
      if (!held) {
        held = createWrites();
        writes.set(id, held);
      }
      return held;
    },
    access(context: StaffContext) {
      return access.get(key(context)) ?? null;
    },
    probe,
    /**
     * Automatic re-check (a 401 or 403, or a change to your own staff entry). Skipped once Settings has closed
     * or another identity, admin host or relay is selected.
     */
    reprobe(context: StaffContext) {
      const now = contextKey();
      if (looking || !retained || now !== `${key(context)} ${context.relay}`)
        return;
      void probe(context, true);
    },
  };
}
export type Staff = ReturnType<typeof createStaff>;

function toAccess(
  outcome: Awaited<ReturnType<RelayStaffBackend["request"]>>,
): Access {
  if (outcome.ok)
    return { state: "authorized", probe: outcome.value as ProbeDto };
  const failure = outcome.failure;
  // A gateway or SSO page (even on a 401 or 403) is not the relay's answer.
  if (failure.category === "intercepted")
    return { state: "unreachable", failure };
  if (failure.authLost) return { state: "denied" };
  if (unsupported(failure)) return { state: "notAdminApi" };
  return { state: "unreachable", failure };
}

function sameAccess(a: Access | undefined, b: Access) {
  if (a?.state !== "authorized" || b.state !== "authorized") return false;
  const keys = Object.keys(b.probe) as (keyof ProbeDto)[];
  return keys.every((key) => a.probe[key] === b.probe[key]);
}
