import type { ChannelSummary } from "../relay/contracts.ts";

/** Presentation provenance in the relay's existing NIP-CL labels, never access. */
export const SOLO_NAMED_LABEL = "buzz.session.named";
/** NIP-CL label marking a Solo chat: a private channel whose owner talks with
 * their agents at top level. Every member and agent reads it from channel
 * metadata. Presentation and composition only; membership stays the access
 * authority. Conversion to a channel clears it. */
export const SOLO_LABEL = "buzz.solo";

export function soloLabels(labels: readonly string[] | undefined): boolean {
  return !!labels?.includes(SOLO_LABEL);
}

/** The viewer's own Solo chat: one they created. Anyone else in a shared
 * Solo chat sees its flat treatment and finds it with their own chats. */
export function ownSolo(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        creator?: string | undefined;
      }>
    | undefined,
  viewer: string | undefined,
): boolean {
  return (
    channel?.channelType === "solo" && !!viewer && channel.creator === viewer
  );
}

export function soloChatLinkName(channel: { id: string; name: string }) {
  // Unnamed chats still carry their starting title from the first prompt.
  return channel.name.trim() || channel.id.slice(0, 8);
}

/** The authorized Solo inventory; unknown metadata never implies Solo. */
export function eligibleSolo(
  channel: ChannelSummary,
  viewer: string | undefined,
) {
  return (
    !channel.archived &&
    channel.channelType === "solo" &&
    (!channel.readOnly || ownSolo(channel, viewer))
  );
}
