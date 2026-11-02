import { useEffect, useSyncExternalStore } from "react";
import type { ComposerSession } from "../messages/composer-session";

/** Shared candidates only. Ordinary mentions observe legacy hints without loading
 * them; native inventory is still ensured through the app-owned controller.
 * Selectors that show `selectable` pass `archive` to demand archive evidence. */
export function useAgentChoices(
  session: ComposerSession,
  includeLegacy = true,
  archive = false,
) {
  const source = session.agentChoices;
  const choices = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  );
  useEffect(() => {
    if (includeLegacy) return source.retain();
  }, [source, includeLegacy]);
  const archiveIdle = archive && choices.archives.status === "idle";
  useEffect(() => {
    if (choices.pending || archiveIdle) source.ensure(includeLegacy, archive);
  }, [source, includeLegacy, archive, archiveIdle, choices.pending, choices]);
  return choices;
}
