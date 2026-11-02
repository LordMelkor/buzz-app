import { useEffect, useSyncExternalStore } from "react";
import type { ComposerSession } from "./composer-session";
const noop = () => () => {};
const unavailable = { status: "unavailable", archived: [] } as const;
const empty = () => unavailable;
/** Observe existing archive evidence; only an open chooser demands its lazy read. */
export function useMentionArchives(session: ComposerSession, demand = false) {
  const snapshot = useSyncExternalStore(
    session.archives?.subscribe ?? noop,
    session.archives?.snapshot ?? empty,
    empty,
  );
  useEffect(() => {
    if (demand) void session.archives?.ensure();
  }, [session, demand]);
  return snapshot;
}
