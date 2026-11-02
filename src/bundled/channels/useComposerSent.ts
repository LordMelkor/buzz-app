import { useCallback, type Dispatch, type SetStateAction } from "react";

/** Keep the mounted composer's callback stable while unrelated workspace data moves. */
export function useComposerSent(
  channelId: string | undefined,
  setSent: Dispatch<
    SetStateAction<{ channelId: string; id: string } | undefined>
  >,
) {
  return useCallback(
    (id: string) => {
      if (!channelId) return;
      setSent({ channelId, id });
    },
    [channelId, setSent],
  );
}
