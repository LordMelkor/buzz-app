// The host's emojiMatches and its pre-Markdown word-token protection.
import { decodeString } from "micromark-util-decode-string";
import type { SourceRange } from "./references";

export function emojiMatches(
  text: string,
  names: ReadonlySet<string>,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  let end = 0;
  if (names.size)
    for (const match of text.matchAll(/(?=(:([a-zA-Z0-9_-]{1,64}):))/g)) {
      const [, whole = "", name = ""] = match;
      if (match.index < end || !names.has(name.toLowerCase())) continue;
      end = match.index + whole.length;
      ranges.push({ start: match.index, end });
    }
  return ranges;
}

export function emojiParts(
  source: string,
  names: ReadonlySet<string>,
  literals: readonly SourceRange[],
): SourceRange[] {
  // Same lowercase HTTP(S) parts excluded by the host's messageParts().
  const excluded = [
    ...literals,
    ...Array.from(source.matchAll(/https?:\/\/[^\s<>"`]+/g), (m) => ({
      start: m.index,
      end: m.index + m[0].length,
    })),
  ].sort((a, b) => a.start - b.start);
  let cursor = 0;
  return emojiMatches(source, names).filter((part) => {
    let skipped = excluded[cursor];
    while (skipped && skipped.end <= part.start) skipped = excluded[++cursor];
    return !skipped || skipped.start >= part.end;
  });
}

/** Private-use words preserve flanking, but are distinct from authored/decoded
 * reference labels. Three UTF-16 units fit even :a:. Two byte-sized PUA digits
 * give 65,536 IDs; the 100k input cap permits <33,334 used/new three-unit words. */
export function protectEmoji(
  source: string,
  parts: readonly SourceRange[],
): string {
  if (!parts.length) return source;
  const used = new Set(
    Array.from(
      decodeString(source).matchAll(/\uE000([\uE100-\uE1FF][\uE200-\uE2FF])/g),
      (m) => m[1],
    ),
  );
  const digits = (id: number) =>
    String.fromCharCode(0xe100 + (id >> 8), 0xe200 + (id & 255));
  const text = source.split("");
  let nonce = 0;
  for (const { start, end } of parts) {
    while (used.has(digits(nonce))) nonce++;
    const token = `\uE000${digits(nonce++)}`.padEnd(end - start, "\uE001");
    for (let i = 0; i < token.length; i++) text[start + i] = token.charAt(i);
  }
  return text.join("");
}
