import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries, ChannelReference } from "../relay/contracts";

const unknown: ChannelReference = Object.freeze({ state: "unknown" });
const noop = () => () => {};

/**
 * What a channel-only link can show about a channel the reader may not have
 * joined. The store owns the lookup, its batching, expiry and retry; this
 * hook only demands one while it is mounted and the list is ready, because
 * discovery owns access.
 */
export function useChannelReference(
  queries: ChannelQueries | undefined,
  channelId: string | undefined,
): ChannelReference {
  const active =
    channelId && queries?.describe && queries.refer ? queries : undefined;
  // The list is replaced on every message preview; re-render only when this
  // reference's answer changes.
  const key = useSyncExternalStore(
    active?.subscribeList ?? noop,
    () =>
      active && channelId
        ? `${active.list().status === "ready" ? "ready" : ""}:${JSON.stringify(active.describe?.(channelId))}`
        : "",
    () => "",
  );
  const ready = key.startsWith("ready:");
  const reference = useMemo<ChannelReference>(
    () => (key ? JSON.parse(key.slice(key.indexOf(":") + 1)) : unknown),
    [key],
  );
  // Mounted links hold the demand, so the store rechecks them when an answer
  // expires or a failure's backoff ends, and keeps a found preview for them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Referring again when the answer changes looks a lost one up again.
  useEffect(() => {
    if (active && channelId && ready) return active.refer?.(channelId);
  }, [active, channelId, ready, reference.state]);
  return reference;
}
