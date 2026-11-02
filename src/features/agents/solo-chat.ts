import type { RelayData } from "../relay/service";

/** Whether a native agent's mention continues a Solo chat: one
 * channel-scoped conversation that posts at channel top level. The channel's
 * Solo label decides, as it does for every member and remote agent. A channel
 * not yet known fails rather than guess the routing. Callers freeze
 * the answer for the turn it admits. */
export async function soloChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  signal.throwIfAborted();
  const { channels } = snapshot.session;
  const list = channels.list();
  const channel =
    channels.get?.(channelId) ??
    list.channels.find(({ id }) => id === channelId);
  if (!channel && list.status !== "ready")
    throw new Error(
      `Couldn't read this community's channels to tell where to answer (${list.error ?? "not loaded"}). Try again.`,
    );
  return channel?.channelType === "solo";
}
