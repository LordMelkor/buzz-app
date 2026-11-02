import {
  USER_STATUS_KIND,
  validStatusEmojiUrl,
  validStatusText,
} from "../src/features/relay/user-status-policy.ts";

/** The status write surface is only the NIP-38 general coordinate. */
export function validStatusTemplate(
  event,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    event?.kind !== USER_STATUS_KIND ||
    typeof event.content !== "string" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    event.created_at > now + 300 ||
    !Array.isArray(event.tags) ||
    event.tags.length > 3 ||
    event.tags.some(
      (tag) =>
        !Array.isArray(tag) ||
        (tag.length !== 2 && (tag.length !== 3 || tag[0] !== "emoji")) ||
        tag.some((value) => typeof value !== "string"),
    )
  )
    return false;
  const keys = event.tags.map(([key]) => key);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !["d", "emoji", "expiration"].includes(key))
  )
    return false;
  if (!event.tags.some(([key, value]) => key === "d" && value === "general"))
    return false;
  const [, emoji, url] = event.tags.find(([key]) => key === "emoji") ?? [];
  if (
    !validStatusText(event.content, emoji ?? "") ||
    (emoji !== undefined && !emoji.trim()) ||
    (url !== undefined && !validStatusEmojiUrl(emoji, url))
  )
    return false;
  const expiration = event.tags.find(([key]) => key === "expiration")?.[1];
  if (
    expiration !== undefined &&
    (!/^\d+$/.test(expiration) ||
      !Number.isSafeInteger(Number(expiration)) ||
      Number(expiration) < 0)
  )
    return false;
  // Clearing is a durable replacement without an expiration.
  return !!(event.content.trim() || emoji || expiration === undefined);
}
