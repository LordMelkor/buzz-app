// Mention turns that were working when the app closed or reloaded, for a type
// whose turns end with the page (`AgentType.resumes`), kept until the owner
// resumes or forgets them. Only each event's id and channel are saved; the
// event is read again from the relay. Each agent membership has its own key, as
// its catch-up progress does, so a program writes only the agents it changed.
import { AGENT_KEY, type AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const INTERRUPTED_PREFIX = "buzz.agents.interrupted.v1:";

/** By agent membership, each mention it was working on: its event id, and its channel
 * or "" without one. */
export type Interrupted = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const ID = /^[0-9a-f]{64}$/;

export function readInterrupted(storage: AgentStore): Interrupted {
  const turns: Record<string, Record<string, string>> = {};
  for (const key of storage.keys()) {
    if (!key.startsWith(INTERRUPTED_PREFIX)) continue;
    const agent = key.slice(INTERRUPTED_PREFIX.length);
    let stored: unknown;
    try {
      stored = JSON.parse(storage.get(key) ?? "null");
    } catch {
      continue;
    }
    if (!AGENT_KEY.test(agent) || !stored || typeof stored !== "object")
      continue;
    const ids = Object.entries(stored).filter(
      (entry): entry is [string, string] =>
        ID.test(entry[0]) && typeof entry[1] === "string",
    );
    if (ids.length) turns[agent] = Object.fromEntries(ids);
  }
  return turns;
}

/** Saves a membership's turns in its own key. Settles once the write is
 * saved; rejects when storage refuses it. */
export function writeInterrupted(
  storage: AgentStore,
  agent: AgentKey,
  turns: Readonly<Record<string, string>>,
) {
  return storage.set(
    `${INTERRUPTED_PREFIX}${agent}`,
    Object.keys(turns).length ? JSON.stringify(turns) : null,
  );
}
