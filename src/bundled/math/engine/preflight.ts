import type { RenderOutcome } from "../contract";

type Token = { text: string; verb: boolean };
type Refusal = Extract<RenderOutcome, { ok: false }>;
const internal: Refusal = Object.freeze({
  ok: false,
  message: "Internal TeX commands are not supported",
});
const header: Refusal = Object.freeze({
  ok: false,
  message: "Environment names and alignment counts must be literal",
});
const untrusted: Refusal = Object.freeze({
  ok: false,
  message: "Links, images and HTML commands are not supported",
});
const trustCommands = new Set([
  "\\href",
  "\\url",
  "\\includegraphics",
  "\\htmlClass",
  "\\htmlId",
  "\\htmlStyle",
  "\\htmlData",
]);
const columns: Refusal = Object.freeze({
  ok: false,
  message: "Too many alignment columns (maximum 32)",
  tooLarge: true,
});

// KaTeX 0.16.47 src/Lexer.ts: preserve its token precedence, ASCII control
// words (including @), control symbols, combining marks and verb delimiters.
const space = "[ \r\n\t]";
const accents = "[\u0300-\u036f]*";
const pattern =
  `(${space}+)|\\\\(\n|[ \r\t]+\n?)[ \r\t]*|` +
  `([!-\\[\\]-\u2027\u202A-\uD7FF\uF900-\uFFFF]${accents}|` +
  `[\uD800-\uDBFF][\uDC00-\uDFFF]${accents}|` +
  "\\\\verb\\*([^]).*?\\4|\\\\verb([^*a-zA-Z]).*?\\5|" +
  `(\\\\[a-zA-Z@]+)${space}*|\\\\[^\uD800-\uDFFF])`;

type Literals = { ranges: { start: number; end: number }[]; cursor: number };
function lex(tex: string, literals?: Literals): Token[] | null {
  const regex = new RegExp(pattern, "gy"),
    tokens: Token[] = [];
  regex.lastIndex = literals?.cursor ?? 0;
  while (regex.lastIndex < tex.length) {
    if (literals) literals.cursor = regex.lastIndex;
    const match = regex.exec(tex);
    if (!match) return null;
    const text = match[6] || match[3] || (match[2] ? "\\ " : " ");
    const verb = match[4] !== undefined || match[5] !== undefined;
    // A bare verb token has no terminating delimiter and is not executable
    // KaTeX syntax. Stop here rather than rescanning many malformed suffixes.
    if (text === "\\verb") return null;
    if (verb)
      literals?.ranges.push({ start: match.index, end: regex.lastIndex });
    if (text === "%") {
      const newline = tex.indexOf("\n", regex.lastIndex);
      regex.lastIndex = newline < 0 ? tex.length : newline + 1;
      literals?.ranges.push({ start: match.index, end: regex.lastIndex });
      continue;
    }
    if (!literals) tokens.push({ text, verb });
  }
  if (literals) literals.cursor = tex.length;
  return tokens;
}

/** Comment and complete verbatim ranges from the pinned preflight lexer.
 * Bare environments share phrasing runs with non-TeX prose: after an unsupported
 * token, resume on the next LF, without rescanning a malformed verb suffix. */
export function texLiteralRanges(
  tex: string,
): readonly { start: number; end: number }[] {
  const percent = tex.includes("%");
  if (!percent && !tex.includes("\\verb")) return [];
  const literals: Literals = { ranges: [], cursor: 0 };
  while (literals.cursor < tex.length) {
    if (lex(tex, literals) !== null) break;
    const newline = tex.indexOf("\n", literals.cursor);
    literals.cursor = newline < 0 ? tex.length : newline + 1;
  }
  return literals.ranges;
}

// Accept only an unexpanded flat argument. No secondary TeX/macro evaluator:
// computed names/counts could conceal the numeric allocation from preflight.
function argument(tokens: readonly Token[], from: number) {
  let i = from;
  while (tokens[i]?.text === " ") i++;
  const first = tokens[i++];
  if (!first || first.verb || first.text.startsWith("\\")) return null;
  if (first.text !== "{") return { text: first.text, end: i };
  let text = "";
  for (let token = tokens[i]; token; token = tokens[++i]) {
    if (token.text === "}") return { text, end: i + 1 };
    if (token.verb || token.text === "{" || token.text.startsWith("\\"))
      return null;
    text += token.text;
  }
  return null;
}

export function renderRefusal(tex: string): Refusal | undefined {
  const tokens = lex(tex);
  if (!tokens) return { ok: false, message: "Unsupported TeX token" };
  // Trust is always off. Refuse these literal tokens before KaTeX can consume
  // their arguments and silently replace the whole command with red text.
  for (const token of tokens)
    if (!token.verb) {
      if (trustCommands.has(token.text)) return untrusted;
      if (token.text.startsWith("\\") && token.text.includes("@"))
        return internal;
    }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.text !== "\\begin" || token.verb) continue;
    const name = argument(tokens, i + 1);
    if (!name || !/^[a-zA-Z]+\*?$/.test(name.text)) return header;
    if (["alignat", "alignat*", "alignedat"].includes(name.text)) {
      const count = argument(tokens, name.end),
        value = count?.text.replaceAll(" ", "");
      if (!count || !value || !/^\d+$/.test(value)) return header;
      const pairs = Number(value);
      if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 16)
        return columns;
      i = count.end - 1;
    } else i = name.end - 1;
  }
}
