import { useCallback, useEffect, useRef, useState } from "react";
import {
  managesCommunity,
  readRoster,
  type Member,
  type RosterReader,
} from "./roster";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** The viewer's role in one community, derived from the relay-signed roster
 * read through that community's own session and verified against the relay
 * authority the session already holds, so the community picker menu can gate
 * owner/admin actions on the roles the Membership settings card reads without
 * asking the broker for the session contract again.
 *
 * `members` is `undefined` while the first read is pending, `null` when the
 * community publishes no member list. A failed re-read keeps the last list and
 * reports `readError`; it never erases a confirmed roster. Passing no session
 * reads nothing and reports no role; a new session starts afresh, so another
 * community's roster never gates this one's actions. */
export function useCommunityRole(
  session: RosterReader | undefined,
  viewer: string | undefined,
) {
  const [members, setMembers] = useState<Member[] | null>();
  const [readError, setReadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const reading = useRef<AbortController | null>(null);
  /** Read-only roster refresh; the newest request wins and never rethrows. */
  const refresh = useCallback(async () => {
    if (!session) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const { signal } = controller;
    setRefreshing(true);
    try {
      const next = await readRoster(session, signal);
      if (signal.aborted) return;
      setMembers(next);
      setReadError("");
    } catch (reason) {
      if (signal.aborted) return;
      setMembers((current) => current ?? null);
      setReadError(`Could not load members: ${message(reason)}`);
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, [session]);
  useEffect(() => {
    setMembers(undefined);
    setReadError("");
    void refresh();
    return () => reading.current?.abort();
  }, [refresh]);
  const role = viewer
    ? members?.find((member) => member.pubkey === viewer)?.role
    : undefined;
  return {
    members,
    role,
    manager: managesCommunity(role),
    readError,
    refreshing,
    refresh,
  };
}
