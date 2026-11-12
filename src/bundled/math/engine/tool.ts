import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes } from "mdast";
import type { AgentTool, MathSpan } from "../contract";
import { indexMessage, literal, fenceMode, unclosedMath } from "./detect";
import { render } from "./render";
import { commandList } from "./commands";

const knownCommands = new Set([
  ...commandList.map((c) => /^\\([A-Za-z]+)/.exec(c.name)?.[1]),
  "end",
  "hline",
  "verb",
]);

/** Diagnostic only. Consume slash runs once; TeX comments/verbatim are literal.
 * Exactly two slashes followed immediately by a known control word is suspect;
 * three slashes are an intentional row break followed by a command. */
function doubledCommand(tex: string): string | undefined {
  for (let i = 0; i < tex.length; ) {
    if (tex[i] === "%") {
      while (i < tex.length && !/[\r\n]/.test(tex.charAt(i))) i++;
      continue;
    }
    if (tex[i] !== "\\") {
      i++;
      continue;
    }
    let end = i;
    while (tex[end] === "\\") end++;
    const slashes = end - i,
      name = /^[A-Za-z]+/.exec(tex.slice(end))?.[0];
    if (slashes === 2 && name && knownCommands.has(name)) return name;
    if (slashes % 2 && name === "verb") {
      let delimiter = end + 4;
      if (tex[delimiter] === "*") delimiter++;
      const open = tex[delimiter];
      if (open && !/[A-Za-z\s]/.test(open)) {
        const close = tex.indexOf(open, delimiter + 1);
        i = close < 0 ? tex.length : close + 1;
        continue;
      }
    }
    i = end + (slashes % 2 && tex[end] === "%" ? 1 : 0);
  }
  return undefined;
}

const syntax =
  "Syntax: $x$ inline; $$…$$ or \\[ … \\] display; math fence; \\ce{} chemistry. No \\href/\\url or sender-defined macros.";
const oneLine = (value: string, max: number) =>
  value.replace(/\s+/g, " ").slice(0, max);
function escaped(source: string, index: number) {
  let n = 0;
  while (source[--index] === "\\") n++;
  return n % 2 === 1;
}
function report(args: Record<string, unknown>): string {
  const markdownGiven = Object.hasOwn(args, "markdown"),
    texGiven = Object.hasOwn(args, "tex");
  if (
    markdownGiven === texGiven ||
    (markdownGiven && typeof args.markdown !== "string") ||
    (texGiven && typeof args.tex !== "string")
  )
    throw Error("Give exactly one string: markdown or tex");
  if (args.display !== undefined && typeof args.display !== "boolean")
    throw Error("display must be a boolean");
  const source = (markdownGiven ? args.markdown : args.tex) as string;
  const line = (offset: number) =>
    1 + (source.slice(0, offset).match(/\r\n|\r|\n/g)?.length ?? 0);
  const excluded: { start: number; end: number }[] = [];
  const spans: MathSpan[] = markdownGiven
    ? [...indexMessage(source, { singleDollar: true }).spans]
    : [
        {
          tex: source,
          source,
          start: 0,
          end: source.length,
          display: args.display === true,
          delimiter: args.display === true ? "$$" : "$",
        },
      ];
  // index deliberately skips literal code. The same parser family supplies
  // fence values here without decoding TeX escapes or scanning code as prose.
  if (markdownGiven && source.length <= 100_000) {
    function visit(node: Nodes) {
      if (literal.has(node.type)) {
        const start = node.position?.start.offset ?? 0,
          end = node.position?.end.offset ?? 0;
        excluded.push({ start, end });
        if (node.type === "code" && fenceMode(node.lang ?? "") !== null)
          spans.push({
            tex: node.value,
            source: source.slice(start, end),
            start,
            end,
            display: true,
            delimiter: "fence",
          });
      }
      // Literal containers such as GFM footnotes can still hold tagged fences.
      if ("children" in node)
        for (const child of node.children) visit(child as Nodes);
    }
    visit(
      fromMarkdown(source, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
    );
  }
  spans.sort((a, b) => a.start - b.start);
  const checked = spans.slice(0, 500);
  const output: string[] = [],
    warnings = new Set<string>();
  let successful = 0,
    failed = 0;
  for (const span of checked) {
    const outcome = render(span.tex, span.display);
    const label =
      span.delimiter === "fence"
        ? "math fence"
        : span.delimiter === "env"
          ? "environment"
          : span.delimiter === "\\("
            ? "\\(…\\)"
            : span.delimiter === "\\["
              ? "\\[…\\]"
              : `${span.delimiter}…${span.delimiter}`;
    if (outcome.ok) {
      successful++;
      output.push(
        `✓ line ${line(span.start)} ${label} ${oneLine(span.tex, 120)}`,
      );
    } else {
      failed++;
      output.push(
        `✗ line ${line(span.start)} ${label} "${oneLine(span.tex, 100)}" → ${oneLine(outcome.message, 180)}`,
      );
    }
    if (!outcome.ok && outcome.tooLarge) continue;
    const doubled = doubledCommand(span.tex);
    if (doubled)
      warnings.add(
        `Warning line ${line(span.start)}: doubled backslash before \\${doubled}; use a single backslash for the command (keep intentional row breaks).`,
      );
    if (
      span.delimiter === "$" &&
      /\\begin\{(?:equation|align|gather|multline|alignat|flalign|split|eqnarray)\*?\}/.test(
        span.tex,
      )
    )
      warnings.add(
        `Warning line ${line(span.start)}: display-only environment inside $…$; use $$…$$.`,
      );
    for (let i = 0; i < span.tex.length; i++)
      if (span.tex[i] === "$" && !escaped(span.tex, i)) {
        warnings.add(
          `Warning line ${line(span.start)}: unescaped $ inside math.`,
        );
        break;
      }
  }
  if (markdownGiven) {
    excluded.sort((a, b) => a.start - b.start);
    const inMath = (offset: number) =>
      checked.some((s) => offset >= s.start && offset < s.end);
    let literalIndex = 0;
    for (let i = 0; i < source.length && i < 100_000; i++) {
      let skipped = excluded[literalIndex];
      while (skipped && skipped.end <= i) skipped = excluded[++literalIndex];
      if (skipped && i >= skipped.start) {
        i = skipped.end - 1;
        continue;
      }
      if (source[i] !== "$" && source[i] !== "\\") continue;
      if (warnings.size >= 30) continue;
      if (
        source[i] === "$" &&
        source[i - 1] !== "$" &&
        !escaped(source, i) &&
        !inMath(i) &&
        /[ \t]/.test(source[i + 1] ?? "")
      )
        warnings.add(
          `Warning line ${line(i)}: $ followed by a space is not an inline math opener.`,
        );
      if (
        source.startsWith("\\\\", i) &&
        /[([$]/.test(source[i + 2] ?? "") &&
        !escaped(source, i) &&
        !inMath(i)
      )
        warnings.add(
          `Warning line ${line(i)}: doubled backslash before ${source[i + 2]}; write \\(, \\[ or $ instead.`,
        );
    }
    for (const open of unclosedMath(source).slice(0, 30)) {
      if (open.delimiter === "$") continue; // Currency-like incomplete dollars are not lint errors.
      const label = open.delimiter === "env" ? "environment" : open.delimiter;
      warnings.add(
        `Warning line ${line(open.start)}: unclosed ${label}; close the math block.`,
      );
    }
    if (source.length > 100_000)
      warnings.add(
        "Warning: message exceeds the 100,000-character detection cap.",
      );
  }
  output.push(...warnings);
  const footer = `${syntax}\nSummary: ${checked.length} spans, ${successful} render, ${failed} fail`;
  const encoder = new TextEncoder();
  let result = "";
  for (const entry of output) {
    if (encoder.encode(`${result + entry}\n${footer}`).length > 3900) {
      result += "… additional details omitted\n";
      break;
    }
    result += `${entry}\n`;
  }
  return result + footer;
}

export const tool: AgentTool = Object.freeze({
  name: "math_check",
  description:
    "Check a draft message's math before sending it to Buzz. Pass markdown to check all prose equations and math fences, or pass tex with an optional display boolean to check one expression. Use $…$ inline with no space inside the dollars, $$…$$ or \\[ … \\] for display equations, and a math fence for standalone TeX. Chemistry supports mhchem \\ce{}. This reports errors and likely delimiter mistakes without sending or changing the message. Links via \\href or \\url and sender-defined macros are not supported.",
  inputSchema: {
    type: "object",
    properties: {
      markdown: { type: "string" },
      tex: { type: "string" },
      display: { type: "boolean" },
    },
  },
  call: async (
    _client: unknown,
    _context: unknown,
    args: Record<string, unknown>,
  ) => report(args),
});
