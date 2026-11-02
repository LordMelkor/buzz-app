import { useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import { recentHuddles } from "./discovery";
import { huddleLifecycle } from "./lifecycle";

/** Incoming room evidence belongs to the viewed conversation, not the local call. */
export function useIncomingHuddle(
  session: RelaySession | undefined,
  parent: string,
) {
  const [state, setState] = useState<{
    session: RelaySession;
    parent: string;
    room: { id: string; participants: number } | undefined;
  }>();
  useEffect(() => {
    if (!session) return;
    const view = session.observe([
      { kinds: [48100], "#h": [parent], limit: 30 },
      { kinds: [48101, 48102, 48103], "#h": [parent], limit: 200 },
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const snapshot = view.snapshot();
      const now = Date.now() / 1000;
      // A failed finite refresh does not invalidate verified live evidence.
      const room = recentHuddles(
        snapshot.events,
        parent,
        session.relayAuthor,
      ).find(
        (candidate) =>
          candidate.startedAt <= now && candidate.startedAt + 3600 > now,
      );
      setState({
        session,
        parent,
        room: room && {
          id: room.id,
          participants: huddleLifecycle(
            snapshot.events,
            room.id,
            parent,
            session.relayAuthor,
          ).participants.length,
        },
      });
      if (room)
        timer = setTimeout(update, (room.startedAt + 3600 - now) * 1000);
    };
    const stop = view.subscribe(update);
    update();
    void view.refresh();
    return () => {
      clearTimeout(timer);
      stop();
      view.dispose();
    };
  }, [session, parent]);
  return state?.session === session && state?.parent === parent
    ? state.room
    : undefined;
}
