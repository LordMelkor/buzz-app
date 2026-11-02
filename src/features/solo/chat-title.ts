import { stageChatCards } from "../messages/composer-chat-cards";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { isBuzzLink } from "../navigation/buzz-links";

/** Remove only structured leading recipient tags; literal @ text remains title content. */
export function startingChatTitle(value: MentionDraft | string): string {
  const draft = stageChatCards(mentionDraft(value), []);
  // Match main’s caption-first title; cards remain the fallback for card-only sends.
  const text =
    composerMarkdown({ ...draft, chatCards: [], gifs: [] }).trim() ||
    composerMarkdown({ ...draft, gifs: [] });
  let start = 0;
  let draftStart = 0;
  for (const recipient of [...draft.recipients].sort(
    (a, b) => a.start - b.start,
  )) {
    if (
      recipient.start < draftStart ||
      draft.text.slice(draftStart, recipient.start).trim()
    )
      break;
    const leading = text.slice(start).match(/^\s*/)?.[0].length ?? 0;
    const tag = `@${recipient.name}`;
    if (!text.startsWith(tag, start + leading)) break;
    start += leading + tag.length;
    draftStart = recipient.end;
  }
  const body = text.slice(start).trim();
  return (
    canonicalDetailsName(
      [
        ...// A link-only prompt falls back to its cards, then "Chat"; the raw
        // link is never the title.
        (
          withoutLeadingBuzzLinks(body) || (draft.chatCards ?? []).join("\n\n")
        ).replace(/\s+/g, " "),
      ]
        .slice(0, 80)
        .join(""),
    ) || "Chat"
  );
}

/** A starting source link, as from Start Solo chat, is context rather than title. */
function withoutLeadingBuzzLinks(text: string) {
  let rest = text;
  for (;;) {
    const [token = ""] = rest.split(/\s/, 1);
    if (!token || !isBuzzLink(token)) return rest;
    rest = rest.slice(token.length).trim();
  }
}
