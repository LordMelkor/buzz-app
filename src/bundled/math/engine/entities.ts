// The host's MessageMarkdown protects these numeric URL-punctuation
// entities before GFM, restoring each as a literal node, never inline content.
import { decodeString } from "micromark-util-decode-string";
import type { SourceRange } from "./references";

export function punctuationEntities(
  source: string,
  literals: readonly SourceRange[],
): SourceRange[] {
  // messageParts() leaves authored lowercase HTTP(S) URL parts untouched.
  const excluded = [
    ...literals,
    ...Array.from(source.matchAll(/https?:\/\/[^\s<>"`]+/g), (m) => ({
      start: m.index,
      end: m.index + m[0].length,
    })),
  ].sort((a, b) => a.start - b.start);
  const cuts: SourceRange[] = [];
  let cursor = 0;
  for (const match of source.matchAll(/&#(?:58|46|64|x3a|x2e|x40);/gi)) {
    const start = match.index,
      end = start + match[0].length;
    let skipped = excluded[cursor];
    while (skipped && skipped.end <= start) skipped = excluded[++cursor];
    if (skipped && skipped.start < end) continue;
    cuts.push({ start, end });
  }
  return cuts;
}

/** Same word flanking as the host's private-use literal token. Only source
 * ranges remove these characters; authored lookalikes never become markers. */
export function protectEntities(
  source: string,
  cuts: readonly SourceRange[],
): string {
  if (!cuts.length) return source;
  // Distinct, unused word tokens avoid binding authored reference labels to
  // each other or to our placeholders. Decoding also catches entity forgeries.
  const folded = decodeString(source).toLowerCase().toUpperCase();
  const used = new Set(
    Array.from(folded.matchAll(/\uE100([a-z0-9]{3})\uE101/gi), (m) =>
      (m[1] ?? "").toLowerCase(),
    ),
  );
  const text = source.split("");
  let nonce = 0;
  for (const { start, end } of cuts) {
    while (used.has(nonce.toString(36).padStart(3, "0"))) nonce++;
    const marker =
      `\uE100${(nonce++).toString(36).padStart(3, "0")}\uE101`.padEnd(
        end - start,
        "\uE101",
      );
    // Every entity is >=5 UTF-16 units; the 100k cap bounds IDs to 3 base-36 digits.
    for (let i = 0; i < marker.length; i++) text[start + i] = marker.charAt(i);
  }
  return text.join("");
}
