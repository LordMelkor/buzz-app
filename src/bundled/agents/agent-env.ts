import { invoke, isTauri } from "@tauri-apps/api/core";
import { pubkeyOf, type AgentKey } from "../../features/agents/membership";

/** The names of the local agent's own environment variables, read fresh
 * from native; `undefined` when they can't be read. Only names are known
 * here: values stay native. Without native (tests, browsers) there are none. */
export async function ownEnvNames(
  pubkey: string,
): Promise<readonly string[] | undefined> {
  if (!isTauri()) return [];
  try {
    const status = await invoke<{ names: string[] } | null>(
      "agent_env_status",
      { agent: pubkey },
    );
    return status?.names ?? [];
  } catch {
    return undefined;
  }
}

/** Whether the local agent has environment variables of its own, as
 * `ownEnvNames` reads them. */
export async function hasOwnEnv(agent: AgentKey): Promise<boolean | undefined> {
  const names = await ownEnvNames(pubkeyOf(agent));
  return names && names.length > 0;
}

/** Agents whose saved list changed since their processes last restarted.
 * Lives as long as the window: a reload stops every agent's processes. */
export const awaitingRestart = new Set<string>();
