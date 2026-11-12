// Host reference boundaries, not notification/name resolution. Inputs are cached
// signed-recipient aliases and channel names supplied by the UI.
// Mirrors the host's profile-mentions.ts and message-references.ts.
import { maskCharacter } from "./masks";

export type SourceRange = { start: number; end: number };

/** Conservative source guards from the host's profile-mentions.ts. In
 * particular, an indented continuation is excluded even when Markdown later
 * parses it as paragraph prose rather than a code node. */
type LinkSearch = {
  line: number;
  label: number;
  paren: number;
  reference: number;
};
function nextClose(text: string, delimiter: string, from: number): number {
  const end = text.indexOf(delimiter, from);
  return end < 0 ? text.length : end;
}
function protectedTextEnd(
  text: string,
  start: number,
  links: LinkSearch,
): number {
  const char = text[start],
    rest = text.slice(start);
  if (links.line < start) links.line = nextClose(text, "\n", start);
  const lineEnd = links.line;
  if (start === 0 || text[start - 1] === "\n") {
    if (/^(?: {4}| {0,3}\t)/.test(rest))
      return Math.min(text.length, lineEnd + 1);
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(rest)?.[1];
    if (fence) {
      if (lineEnd === text.length) return text.length;
      const closing = new RegExp(
        `^ {0,3}${fence[0]}{${fence.length},}[\\t ]*\\r?$`,
        "gm",
      );
      closing.lastIndex = lineEnd + 1;
      const match = closing.exec(text);
      return match ? match.index + match[0].length : text.length;
    }
  }
  const boundary = start === 0 || /[\s<([]/.test(text[start - 1] ?? "");
  if (char !== "`" && char !== "~" && char !== "[" && char !== "!" && !boundary)
    return start;
  const span = /^(?:`+|~{3,})/.exec(rest)?.[0];
  if (span) {
    const end = text.indexOf(span, start + span.length);
    return end < 0 ? text.length : end + span.length;
  }
  if (char === "[" || rest.startsWith("![")) {
    // The host guard ends each label/target at its first closing delimiter,
    // without escape/nesting semantics. Cache each search independently: all
    // requested starts advance, including failed targets after nested labels.
    // A missing delimiter uses EOF as a sentinel, never a repeated suffix scan.
    const from = start + (char === "!" ? 2 : 1);
    if (links.label < from) links.label = nextClose(text, "]", from);
    if (links.label < lineEnd) {
      const target = links.label + 2;
      if (text[links.label + 1] === "(") {
        if (links.paren < target) links.paren = nextClose(text, ")", target);
        if (links.paren < lineEnd) return links.paren + 1;
      } else if (text[links.label + 1] === "[") {
        if (links.reference < target)
          links.reference = nextClose(text, "]", target);
        if (links.reference < lineEnd) return links.reference + 1;
      }
    }
  }
  const url = /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:|nostr:)[^\s<>`]+/i.exec(
    rest,
  )?.[0];
  return url ? start + url.length : start;
}

export function profileCuts(
  source: string,
  names: readonly string[],
  literals: readonly SourceRange[],
) {
  const counts = new Map<string, number>();
  for (const name of names)
    if (name && !/[\r\n]/.test(name) && source.includes(`@${name}`))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  const candidates = [...counts.keys()].sort((a, b) => b.length - a.length);
  const cuts: SourceRange[] = [],
    unknown: SourceRange[] = [];
  const links: LinkSearch = { line: -1, label: -1, paren: -1, reference: -1 };
  const ordered = [...literals].sort((a, b) => a.start - b.start);
  let literal = 0;
  for (let i = 0; i < source.length; i++) {
    const protectedEnd = protectedTextEnd(source, i, links);
    if (protectedEnd > i) {
      i = protectedEnd - 1;
      continue;
    }
    if (
      source[i] !== "@" ||
      (i && /[\p{L}\p{N}_@/\\]/u.test(source.charAt(i - 1))) ||
      /\s/.test(source[i + 1] ?? " ")
    )
      continue;
    let blocked = ordered[literal];
    while (blocked && blocked.end <= i) blocked = ordered[++literal];
    if (blocked && blocked.start <= i) continue;
    const name = candidates.find(
      (name) =>
        source.startsWith(name, i + 1) &&
        !/[\p{L}\p{N}_]/u.test(source[i + 1 + name.length] ?? ""),
    );
    const end = i + 1 + (name?.length ?? 0);
    const qualifier = /^ \([a-f0-9]{64}\)/i.exec(source.slice(end))?.[0];
    if (
      !name ||
      counts.get(name) !== 1 ||
      qualifier ||
      (blocked && blocked.start < end)
    ) {
      unknown.push({ start: i, end: end + (qualifier?.length ?? 0) });
    } else cuts.push({ start: i, end });
    i = end - 1;
  }
  return { cuts, unknown };
}

/** Same UTF-16 length and punctuation flanking as the host's protected token.
 * Offsets remain raw; removal uses ranges, never authored sentinel characters. */
export function protectProfiles(
  source: string,
  cuts: readonly SourceRange[],
): string {
  if (!cuts.length) return source;
  const word = maskCharacter(source, false),
    punctuation = maskCharacter(source, true),
    text = source.split("");
  for (const { start, end } of cuts) {
    text.fill(word, start, end);
    text[start] = punctuation;
    if (/[\p{P}\p{S}]$/u.test(source.slice(start, end)))
      text[end - 1] = punctuation;
  }
  return text.join("");
}

/** Channel references are split AFTER Markdown parsing, on decoded text. */
export function channelCuts(
  text: string,
  channels: readonly string[],
): SourceRange[] {
  const counts = new Map<string, number>();
  for (const name of channels)
    if (name && text.includes(`#${name}`))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  const candidates = [...counts]
    .filter(([, count]) => count === 1)
    .map(([name]) => `#${name}`)
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return [];
  const cuts: SourceRange[] = [],
    covered = new Uint8Array(text.length);
  for (const label of candidates) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(label, from);
      if (start < 0) break;
      const end = start + label.length;
      from = end;
      if (
        (start && !/[\s([{]/u.test(text.charAt(start - 1))) ||
        (end < text.length && !/[\s.,!?;:)\]}]/u.test(text.charAt(end))) ||
        covered[start] ||
        covered[end - 1]
      )
        continue;
      // Longest-first: an earlier cut cannot sit strictly inside this one,
      // so occupied endpoints detect every overlap, even out of source order.
      covered.fill(1, start, end);
      cuts.push({ start, end });
    }
  }
  return cuts.sort((a, b) => a.start - b.start);
}
