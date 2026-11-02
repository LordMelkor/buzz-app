import type { ChannelSummary } from "../relay/contracts";

/** Team navigation lists channels. Every Solo chat the viewer belongs to,
 * their own or shared with them, is listed with their chats instead. */
export function inTeamInventory(channel: ChannelSummary): boolean {
  return channel.channelType !== "solo";
}
