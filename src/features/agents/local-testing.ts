import type { LocalAgent, LocalAgents, LocalAgentsSnapshot } from "./local";

/** A settable local-agent list; no keys, relay or runtime. */
export function localAgentsFixture(
  agents: readonly LocalAgent[] = [],
  status: LocalAgentsSnapshot["status"] = "ready",
) {
  let state: LocalAgentsSnapshot = { status, agents };
  const listeners = new Set<() => void>();
  let reads = 0;
  let read: () => void | Promise<void> = () => {};
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Counts reload demand; `onRefresh` scripts what each read reports. */
    async refresh() {
      reads++;
      await read();
    },
    reads: () => reads,
    onRefresh(next: () => void | Promise<void>) {
      read = next;
    },
    /** An error lasts only as long as the update that reports it. */
    set(next: Partial<LocalAgentsSnapshot>) {
      state = {
        status: next.status ?? state.status,
        agents: next.agents ?? state.agents,
        ...((next.hosted ?? state.hosted)
          ? { hosted: next.hosted ?? state.hosted }
          : {}),
        ...(next.error ? { error: next.error } : {}),
      };
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  } satisfies LocalAgents & Record<string, unknown>;
}
