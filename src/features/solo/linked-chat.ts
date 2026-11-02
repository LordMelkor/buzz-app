import { parseBuzzLink } from "../navigation/buzz-links";
import { readView } from "../../shared/view-state";

/** One unsent shortcut; the link itself is ordinary editable message content. */
export type LinkedChat = {
  channelId: string;
  link: string;
};
export function readLinkedChat(
  scope: string,
  key: string,
): LinkedChat | undefined {
  const value = readView<Partial<LinkedChat> | null>(scope, key, null);
  if (
    !value ||
    typeof value.link !== "string" ||
    typeof value.channelId !== "string"
  )
    return;
  const target = parseBuzzLink(value.link);
  if (target?.format !== "legacy" || target.channelId !== value.channelId)
    return;
  return value as LinkedChat;
}
export const linkedDraftKey = (id: string) => `solo:linked:${id}`;
/** One draft per source: starting again from it returns to the unsent prompt
 * instead of stranding it under a fresh key. */
export async function linkedDraftId(source: LinkedChat) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${source.channelId}\n${source.link}`),
    ),
  );
  const hex = [...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
