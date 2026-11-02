const SHORTCODE = "[a-zA-Z0-9_+-]{2,64}";
const QUERY = new RegExp(`:(${SHORTCODE})$`, "u");
const CLOSED = new RegExp(`:${SHORTCODE}:$`, "u");
// Pictographs plus the code points that end skin-tone, flag, keycap and tag
// (England/Scotland/Wales) sequences.
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u20E3|\u{E007F})[\uFE0E\uFE0F]?$/u;

/**
 * Start/whitespace/opening-bracket boundaries exclude URLs, times and closed codes.
 * A converted emoji or a completed shortcode at its own boundary also counts, so
 * `😄:wave` and `:bufo::wave` chain without a space while `std::vector` stays text.
 */
export function emojiQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = before.match(QUERY);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  if (!atBoundary(before.slice(0, start))) return null;
  return { start, end: caret, query };
}

function atBoundary(prefix: string): boolean {
  if (prefix === "" || /[\s([{]$/u.test(prefix) || EMOJI.test(prefix))
    return true;
  const closed = prefix.match(CLOSED);
  return closed !== null && atBoundary(prefix.slice(0, -closed[0].length));
}
