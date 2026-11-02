import type { EventTemplate } from "nostr-tools";

/** Typing carries conversation scope only, never draft content or recipients. */
export function validTypingTemplate(value: unknown): value is EventTemplate {
  if (!value || typeof value !== "object") return false;
  const event = value as EventTemplate;
  if (
    event.kind !== 20002 ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    )
  )
    return false;
  const [channel, ...references] = event.tags;
  return (
    !!channel &&
    channel.length === 2 &&
    channel[0] === "h" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(channel[1] ?? "") &&
    references.length <= 2 &&
    references.every(
      (tag, index) =>
        tag.length === 4 &&
        tag[0] === "e" &&
        /^[0-9a-f]{64}$/.test(tag[1] ?? "") &&
        tag[2] === "" &&
        tag[3] === (references.length === 2 && index === 0 ? "root" : "reply"),
    )
  );
}
