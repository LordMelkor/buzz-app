import { useMemo, useSyncExternalStore } from "react";
import type { Profile } from "../relay/contracts";
import type { ComposerSession } from "../messages/composer-session";
import { knownAgentPubkeys } from "./known";

/** One display-only projection per owning surface; exact keys, never display names.
 * Subscribes to existing evidence without initiating library reads. */
export function useKnownAgentPubkeys(
  session: ComposerSession,
  profiles: ReadonlyMap<string, Profile>,
): ReadonlySet<string> {
  const library = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  return useMemo(
    () => knownAgentPubkeys(profiles, library),
    [profiles, library],
  );
}
