export const USER_STATUS_KIND = 30315;
export const STATUS_TEXT_LIMIT = 100;

/** Wire limits use UTF-16 units. Callers own trimming and optional-tag policy. */
export function validStatusText(text: string, emoji: string): boolean {
  return (
    text.length <= STATUS_TEXT_LIMIT &&
    emoji.length <= STATUS_TEXT_LIMIT &&
    !/[\r\n]/.test(text + emoji)
  );
}

/** A custom `:code:` status carries its original image URL as the emoji tag's
 * third value, so it renders without the viewer's catalog. */
export function validStatusEmojiUrl(emoji: string, url: string): boolean {
  return (
    /^:[a-z0-9_-]{1,64}:$/i.test(emoji) &&
    url === url.trim() &&
    url.length <= 2048 &&
    /^https?:\/\/\S/i.test(url)
  );
}
