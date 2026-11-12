import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { decodeString } from "micromark-util-decode-string";
import type { Nodes, Parents, Root } from "mdast";
import type {
  DetectOptions,
  MathIndex,
  MathSpan,
  SegmentPiece,
  FenceMode,
} from "../contract";
import { profileCuts, protectProfiles, channelCuts } from "./references";
import { spoilerMarkers, protectSpoilers, spoilerLayout } from "./spoilers";
import { punctuationEntities, protectEntities } from "./entities";
import { emojiMatches, emojiParts, protectEmoji } from "./emoji";
import { referencedFootnotes } from "./footnotes";
import { render } from "./render";
import { trimTex } from "../contract";
import { texLiteralRanges } from "./preflight";

const none: readonly SegmentPiece[] = Object.freeze([]);
const empty: MathIndex = Object.freeze({
  spans: Object.freeze([]),
  drawn: Object.freeze([]),
  pieces: () => none,
});
export type OpenMath = Readonly<{
  delimiter: MathSpan["delimiter"];
  start: number;
}>;
type ScanResult = { spans: MathSpan[]; open: OpenMath | null };
type Analysis = {
  index: MathIndex;
  unclosed: readonly OpenMath[];
  inside: boolean;
};
const emptyAnalysis: Analysis = { index: empty, unclosed: [], inside: false };
const cache = new Map<string, Analysis>();
// No delimiters means no math under ANY reference/single-dollar options.
// Key by the original body, avoiding a scan/composite-key hash per host segment.
const negative = new Set<string>();
export const literal = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "footnoteReference",
  "footnoteDefinition",
]);
const phrasing = new Set(["paragraph", "heading", "tableCell"]);
type Range = { start: number; end: number };
type Segment = {
  text: string;
  positions: Range[];
  marked: boolean;
  spoiler?: boolean;
};

function range(node: Nodes): Range {
  return {
    start: node.position?.start.offset ?? 0,
    end: node.position?.end.offset ?? 0,
  };
}
/** Index into a collection whose bounds the caller has already established. */
function nth<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`Missing item ${index}`);
  return item;
}
function lineStarts(source: string): Uint32Array {
  const starts = new Uint32Array(source.length + 1);
  let lineStart = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n" || source[i] === "\r") lineStart = i + 1;
    starts[i + 1] = lineStart;
  }
  return starts;
}
function escapeParity(source: string): Uint8Array {
  const parity = new Uint8Array(source.length);
  let odd = 0;
  for (let i = 0; i < source.length; i++) {
    parity[i] = odd;
    odd = source[i] === "\\" ? 1 - odd : 0;
  }
  return parity;
}

/** Decode with a source projection: one entry per UTF-16 code unit, including
 * multi-unit character references. Source positions remain raw TeX positions. */
function projection(
  raw: string,
  start: number,
  lines: Uint32Array,
  prefixes: ReadonlyMap<number, number>,
): { text: string; positions: Range[] } {
  let text = "";
  const positions: Range[] = [];
  const tokens =
    /\\[!-/:-@[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);|\r\n|\r|[\s\S]/g;
  for (const token of raw.matchAll(tokens)) {
    const at = start + token.index,
      line = nth(lines, at);
    if (at < line + (prefixes.get(line) ?? 0)) continue;
    const decoded =
      token[0] === "\0"
        ? "\uFFFD"
        : token[0] === "\r" || token[0] === "\r\n"
          ? "\n"
          : decodeString(token[0]);
    text += decoded;
    for (let i = 0; i < decoded.length; i++)
      positions.push({
        start: start + token.index,
        end: start + token.index + token[0].length,
      });
  }
  return { text, positions };
}

function segments(
  tree: Root,
  content: string,
  lines: Uint32Array,
  prefixes: ReadonlyMap<number, number>,
): Segment[] {
  const result: Segment[] = [];
  const footnotes = content.includes("[^")
    ? referencedFootnotes(tree)
    : new Set<Nodes>();
  function visit(node: Nodes, marked = false, visible = true) {
    // Definition bodies never scan as math, but their actual prose occurrences
    // must count in alias checks. An unused outer note can contain a referenced
    // nested definition, so traverse it without offering the outer text.
    if (node.type === "footnoteDefinition") {
      for (const child of node.children)
        visit(child as Nodes, marked, footnotes.has(node));
      return;
    }
    if (literal.has(node.type)) return;
    // Rich formatting is a placement preference, never a rendering veto.
    marked ||=
      node.type === "emphasis" ||
      node.type === "strong" ||
      node.type === "delete";
    if (node.type === "text") {
      if (!visible) return;
      const at = range(node);
      const decoded = projection(
        content.slice(at.start, at.end),
        at.start,
        lines,
        prefixes,
      );
      let cursor = 0;
      // remark-breaks splits an already-decoded text node at each line ending.
      // Micromark has already removed line-edge/container indentation. Locate
      // each value line in the decoded raw slice, skipping those source gaps.
      for (const text of node.value.split(/\r\n|\r|\n/)) {
        if (!text) continue;
        const index =
          cursor < decoded.text.length
            ? decoded.text.indexOf(text, cursor)
            : -1;
        const positions =
          index < 0 ? [] : decoded.positions.slice(index, index + text.length);
        result.push({ text, positions, marked });
        cursor = index < 0 ? decoded.text.length : index + text.length;
      }
    } else if ("children" in node)
      for (const child of node.children) visit(child as Nodes, marked, visible);
  }
  visit(tree);
  return result;
}

function hostStructure(
  content: string,
  references?: DetectOptions["references"],
) {
  const lines = lineStarts(content),
    prefixes = new Map<number, number>(),
    quotes = new Set<number>();
  // Collect actual container markers from the existing parse, not body > text
  // (including indented/lazy continuation lines inside a blockquote).
  const parse = (source: string) =>
    fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [
        gfmFromMarkdown(),
        {
          enter: {
            blockQuoteMarker(token) {
              quotes.add(token.start.offset);
            },
          },
        },
      ],
    });
  const needsProfiles = references !== undefined && content.includes("@");
  const needsSpoilers = content.includes("||");
  const needsEntities = content.includes("&#");
  const emojiNames = new Set(references?.emoji ?? []);
  const needsEmoji = emojiNames.size > 0 && content.includes(":");
  // Host preparation uses CommonMark for literal ranges and a table-only
  // parse for spoiler discovery. Autolinks must run AFTER protection.
  const spoilerTree = needsSpoilers
    ? fromMarkdown(content, {
        extensions: [gfmTable()],
        mdastExtensions: [gfmTableFromMarkdown()],
      })
    : undefined;
  const original =
    needsProfiles || needsEntities || needsEmoji
      ? fromMarkdown(content)
      : (spoilerTree ?? parse(content));
  const literals: Range[] = [];
  function findLiteral(node: Nodes) {
    if (literal.has(node.type)) literals.push(range(node));
    else if ("children" in node)
      for (const child of node.children) findLiteral(child as Nodes);
  }
  if (needsProfiles || needsEntities || needsEmoji) findLiteral(original);
  // An omitted context is a standalone draft/tool check. Prose passes an
  // explicit context, even while cold, so missing bindings stay conservative.
  const profiles = needsProfiles
    ? profileCuts(content, references.names, literals)
    : { cuts: [], unknown: [] };
  let profile = 0;
  const markers = (
    spoilerTree ? spoilerMarkers(spoilerTree, content, literal) : []
  ).filter((m) => {
    let cut = profiles.cuts[profile];
    while (cut && cut.end <= m.start) cut = profiles.cuts[++profile];
    return !cut || m.end <= cut.start;
  });
  const entities = needsEntities
    ? punctuationEntities(content, [...literals, ...profiles.cuts])
    : [];
  const emoji = needsEmoji
    ? emojiParts(content, emojiNames, [...literals, ...profiles.cuts])
    : [];
  const protectedContent = protectEmoji(
    protectEntities(
      protectSpoilers(protectProfiles(content, profiles.cuts), markers),
      entities,
    ),
    emoji,
  );
  const tree =
    needsProfiles || needsSpoilers || needsEntities || needsEmoji
      ? parse(protectedContent)
      : original;
  // Build before projection; rendering, raw copy and joins share this index.
  for (let i = 0; i < content.length; i++)
    if (lines[i] === i) {
      let end = i;
      while (content[end] === " " || content[end] === "\t" || quotes.has(end))
        end++;
      if (end > i) prefixes.set(i, end - i);
    }
  const spoilers = spoilerLayout(tree, markers);
  const boundaries: (Range & { text?: string })[] = [
    ...profiles.cuts,
    ...spoilers.edges,
    ...entities,
  ].sort((a, b) => a.start - b.start);
  // Generic literal cuts also prevent an outside anchor from revealing a
  // crossing spoiler. Mark membership alone is insufficient for concealment.
  const offered: Segment[] = [],
    cuts: Range[] = [...boundaries];
  let cutIndex = 0,
    markIndex = 0,
    emojiIndex = 0;
  const inSpoiler = (start: number, end: number) => {
    let mark = spoilers.marks[markIndex];
    while (mark && mark.end <= start) mark = spoilers.marks[++markIndex];
    return Boolean(mark && start < mark.end && mark.start < end);
  };
  for (const segment of segments(tree, protectedContent, lines, prefixes)) {
    // Nonliteral emoji tokens restore into the same text node, with raw offsets
    // intact. Removal/restoration never trusts authored sentinel characters.
    if (emoji.length) {
      const text = segment.text.split("");
      segment.positions.forEach((position, i) => {
        let part = emoji[emojiIndex];
        while (part && part.end <= position.start) part = emoji[++emojiIndex];
        if (part && part.start <= position.start && position.end <= part.end)
          text[i] = content.charAt(position.start);
      });
      segment.text = text.join("");
    }
    let from = 0;
    const add = (start: number, end: number) => {
      const text = segment.text.slice(start, end),
        positions = segment.positions.slice(start, end);
      const first = positions[0],
        last = positions.at(-1);
      const marked = segment.marked,
        spoiler = Boolean(first && last && inSpoiler(first.start, last.end));
      let offset = 0;
      for (const cut of channelCuts(text, references?.channels ?? [])) {
        const first = positions[cut.start],
          last = positions[cut.end - 1];
        if (!first || !last) continue;
        cuts.push({ start: first.start, end: last.end });
        // ReferenceText offers even its empty leading/trailing text fragments.
        offered.push({
          text: text.slice(offset, cut.start),
          positions: positions.slice(offset, cut.start),
          marked,
          spoiler,
        });
        offset = cut.end;
      }
      offered.push({
        text: text.slice(offset),
        positions: positions.slice(offset),
        marked,
        spoiler,
      });
    };
    for (let i = 0; i < segment.positions.length; i++) {
      const position = nth(segment.positions, i);
      let passed = boundaries[cutIndex];
      while (passed && passed.end <= position.start)
        passed = boundaries[++cutIndex];
      const cut = passed;
      if (cut && position.start < cut.end && position.end > cut.start) {
        if (i > from) add(from, i);
        if (position.start === cut.start && "text" in cut && cut.text)
          offered.push({
            text: cut.text,
            positions: Array.from({ length: cut.text.length }, () => ({
              start: cut.start,
              end: cut.end,
            })),
            marked: segment.marked,
            spoiler: inSpoiler(cut.start, cut.end),
          });
        from = i + 1;
      }
    }
    if (from < segment.text.length) add(from, segment.text.length);
  }
  // The host's bare-link navigation grammar is intentionally not duplicated.
  // Unknown segmentation can alias text elsewhere, so the safe fallback covers
  // this whole prose body, not merely the paragraph containing the candidate.
  const bareLink = offered.some((segment) =>
    /(?:https?|buzz):\/\//i.test(segment.text),
  );
  return {
    tree,
    offered,
    cuts: cuts.sort((a, b) => a.start - b.start),
    unknown: profiles.unknown,
    bareLink,
    lines,
    prefixes,
  };
}

/** Exported for the host-fixture fidelity test, not a second public engine API. */
export function hostSegments(
  content: string,
  references?: DetectOptions["references"],
): readonly string[] {
  return hostStructure(content, references).offered.map(
    (segment) => segment.text,
  );
}

function balancedEnvironments(
  source: string,
  start: number,
  end: number,
  parity: Uint8Array,
): Map<number, number> {
  const stacks = new Map<string, number[]>(),
    pairs = new Map<number, number>();
  // A name cannot contain another header start. Restrict the search to this
  // literal-free run as well, including on an unsuccessful final search.
  const tokens = /\\(begin|end)\{([a-zA-Z]+\*?)\}/g;
  const excluded = texLiteralRanges(source.slice(start, end));
  let exclusion = 0;
  for (const token of source.slice(start, end).matchAll(tokens)) {
    const at = start + token.index;
    let skipped = excluded[exclusion];
    while (skipped && skipped.end <= token.index)
      skipped = excluded[++exclusion];
    if (parity[at] || (skipped && skipped.start <= token.index)) continue;
    const name = token[2] ?? "";
    const stack = stacks.get(name) ?? [];
    stacks.set(name, stack);
    if (token[1] === "begin") stack.push(at);
    else {
      const opener = stack.pop();
      if (opener !== undefined) pairs.set(opener, at + token[0].length);
    }
  }
  return pairs;
}

/** Context-neutral source for rendering/copy; raw offsets still address content. */
function withoutPrefixes(
  source: string,
  start: number,
  end: number,
  prefixes: ReadonlyMap<number, number>,
): string {
  return source
    .slice(start, end)
    .replace(
      /(\r\n|\r|\n)([^\r\n]*)/g,
      (_match, newline: string, line: string, offset: number) =>
        newline +
        line.slice(prefixes.get(start + offset + newline.length) ?? 0),
    );
}

function scan(
  source: string,
  start: number,
  end: number,
  options: DetectOptions,
  prefixes: ReadonlyMap<number, number>,
  parity: Uint8Array,
  lines: Uint32Array,
  containerStart: number,
): ScanResult {
  const result: MathSpan[] = [];
  let open: OpenMath | null = null;
  const missingClosers = new Set<string>();
  let environmentEnds: Map<number, number> | undefined;
  for (let i = start; i < end && result.length < 500; i++) {
    if (parity[i]) continue;
    let delimiter: MathSpan["delimiter"] | undefined;
    let close = -1,
      stop = -1,
      texStart = i;
    const current = source.slice(i, i + 2);
    if (current === "$$" || current === "\\[" || current === "\\(") {
      delimiter = current as "$$" | "\\[" | "\\(";
      const closing =
        current === "\\[" ? "\\]" : current === "\\(" ? "\\)" : "$$";
      texStart = i + 2;
      if (!missingClosers.has(closing)) {
        for (let j = texStart; j < end - 1; j++) {
          if (source.startsWith(closing, j) && !parity[j]) {
            close = j;
            stop = j + 2;
            break;
          }
        }
        if (close < 0) missingClosers.add(closing);
      }
      // An unmatched opener stays prose; keep scanning for later valid math.
      if (close < 0) {
        open ??= { delimiter, start: i };
        if (current === "$$") i++;
        continue;
      }
    } else if (
      source[i] === "$" &&
      source[i - 1] !== "$" &&
      source[i + 1] !== "$" &&
      options.singleDollar &&
      !/\s/.test(source[i + 1] ?? " ")
    ) {
      delimiter = "$";
      texStart = i + 1;
      let blocked = false;
      for (let j = texStart; j < end && !/[\r\n]/.test(source.charAt(j)); j++) {
        if (source[j] !== "$" || parity[j]) continue;
        blocked = true;
        // Do not pair across an intervening currency delimiter or a $$ block.
        if (
          source[j + 1] !== "$" &&
          source[j - 1] !== "$" &&
          (!/\s/.test(source.charAt(j - 1)) ||
            /\\[a-zA-Z]+[ \t]+$/.test(source.slice(texStart, j))) &&
          !/[0-9]/.test(source[j + 1] ?? "")
        ) {
          close = j;
          stop = j + 1;
        }
        break;
      }
      if (close < 0 && !blocked && !/[\r\n]/.test(source.slice(texStart, end)))
        open ??= { delimiter, start: i };
    } else if (source.startsWith("\\begin{", i)) {
      const lineStart = nth(lines, i);
      const atLineStart =
        i === containerStart ||
        /^[ \t]*$/.test(
          source.slice(lineStart + (prefixes.get(lineStart) ?? 0), i),
        );
      const begin =
        atLineStart &&
        /^\\begin\{(?:equation|align|gather|multline|alignat|flalign|split|eqnarray)\*?\}/.test(
          source.slice(i, end),
        );
      if (begin) {
        environmentEnds ??= balancedEnvironments(source, i, end, parity);
        const envEnd = environmentEnds.get(i);
        if (envEnd === undefined) open ??= { delimiter: "env", start: i };
        if (envEnd !== undefined) {
          let lineEnd = envEnd;
          while (
            lineEnd < source.length &&
            source[lineEnd] !== "\r" &&
            source[lineEnd] !== "\n"
          )
            lineEnd++;
          if (/^[ \t]*$/.test(source.slice(envEnd, lineEnd))) {
            delimiter = "env";
            close = envEnd;
            stop = envEnd;
          }
        }
      }
    }
    if (!delimiter || close < 0 || stop > end) continue;
    const tex = trimTex(withoutPrefixes(source, texStart, close, prefixes));
    if (!tex) {
      i = stop - 1;
      continue;
    }
    result.push(
      Object.freeze({
        tex,
        display: delimiter !== "$" && delimiter !== "\\(",
        delimiter,
        source: withoutPrefixes(source, i, stop, prefixes),
        start: i,
        end: stop,
      }),
    );
    i = stop - 1;
  }
  return { spans: result, open };
}

/** Internal work-budget test seam; not part of the Engine/UI contract. */
export function scansIn(
  tree: Root,
  content: string,
  options: DetectOptions,
  prefixes: ReadonlyMap<number, number>,
  cuts: readonly Range[],
  unknown: readonly Range[],
  parity: Uint8Array,
  lines: Uint32Array,
) {
  const runs: {
    start: number;
    end: number;
    containerStart: number;
    result: ScanResult;
  }[] = [];
  let cutCursor = 0,
    unknownCursor = 0;
  function visit(node: Nodes) {
    if (literal.has(node.type)) return;
    if (phrasing.has(node.type)) {
      const whole = range(node);
      // A recipient whose name is not cached is not safe to map. Keep only
      // that phrasing container raw; other paragraphs still get their math.
      let unmapped = unknown[unknownCursor];
      while (unmapped && unmapped.end <= whole.start)
        unmapped = unknown[++unknownCursor];
      if (unmapped && unmapped.start < whole.end) return;
      let passed = cuts[cutCursor];
      while (passed && passed.end <= whole.start) passed = cuts[++cutCursor];
      const excluded: Range[] = [];
      for (
        let i = cutCursor, edge = cuts[i];
        edge && edge.start < whole.end;
        edge = cuts[++i]
      )
        if (edge.end > whole.start) excluded.push(edge);
      function findSkipped(child: Nodes) {
        if (literal.has(child.type)) excluded.push(range(child));
        else if ("children" in child)
          for (const item of child.children) findSkipped(item as Nodes);
      }
      for (const child of (node as Parents).children)
        findSkipped(child as Nodes);
      let start = whole.start;
      for (const skip of [
        ...excluded,
        { start: whole.end, end: whole.end },
      ].sort((a, b) => a.start - b.start)) {
        if (skip.start >= start)
          runs.push({
            start,
            end: skip.start,
            containerStart: whole.start,
            result: scan(
              content,
              start,
              skip.start,
              options,
              prefixes,
              parity,
              lines,
              whole.start,
            ),
          });
        start = Math.max(start, skip.end);
      }
    } else if ("children" in node)
      for (const child of node.children) visit(child as Nodes);
  }
  visit(tree);
  return runs;
}

/** Non-whitespace edges of a physical source line after its block prefixes.
 * Cache each queried line: fragmented long lines must not be rescanned per piece. */
function breakEdges(
  content: string,
  lines: Uint32Array,
  prefixes: Map<number, number>,
  tree: Root,
) {
  const starts = new Map(
    [...prefixes].map(([line, length]) => [line, line + length]),
  );
  function visit(node: Nodes) {
    // Parsed block starts also account for first-line list/quote markers and
    // ATX heading prefixes. Never skip inline formatting or other prose.
    if (node.type === "paragraph" || node.type === "heading") {
      const first = range(
        node.type === "heading" && node.children[0]
          ? (node.children[0] as Nodes)
          : node,
      ).start;
      const line = nth(lines, first);
      starts.set(line, Math.max(starts.get(line) ?? line, first));
    }
    if ("children" in node)
      for (const child of node.children) visit(child as Nodes);
  }
  visit(tree);
  const cache = new Map<number, Range>();
  return (line: number): Range => {
    let edge = cache.get(line);
    if (!edge) {
      let cursor = starts.get(line) ?? line,
        first: number | undefined,
        last = cursor;
      for (
        ;
        cursor < content.length &&
        content[cursor] !== "\r" &&
        content[cursor] !== "\n";
        cursor++
      )
        if (!/\s/.test(content.charAt(cursor))) {
          first ??= cursor;
          last = cursor + 1;
        }
      edge = {
        start: first ?? cursor,
        end: first === undefined ? cursor : last,
      };
      cache.set(line, edge);
    }
    return edge;
  };
}

type MappedPiece = { segment: number; piece: SegmentPiece };
/** Prefer an unformatted carrier per line; host BRs own the newlines. */
function copySources(
  span: MathSpan,
  touched: MappedPiece[],
  segments: Segment[],
  content: string,
  lines: Uint32Array,
  edges: (line: number) => Range,
): boolean {
  const text = span.source.split(/\r\n|\r|\n/),
    starts = [nth(lines, span.start)];
  for (const match of content
    .slice(span.start, span.end)
    .matchAll(/\r\n|\r|\n/g))
    starts.push(span.start + match.index + match[0].length);
  const carriers = new Map<number, MappedPiece>();
  let previousEnd: number | undefined;
  for (const part of touched) {
    const segment = nth(segments, part.segment),
      first = nth(segment.positions, part.piece.start),
      last = nth(segment.positions, part.piece.end - 1);
    const line = nth(lines, first.start),
      edge = edges(line);
    part.piece = {
      ...part.piece,
      joinBefore:
        (span.display || line !== lines[span.start]) &&
        first.start <= edge.start,
      joinAfter: span.display && last.end >= edge.end,
    };
    if (previousEnd !== undefined) {
      const gap = content.slice(previousEnd, first.start);
      // An entity-generated BR has no physical source newline to copy. With
      // selectable host BRs, that layout cannot reconstruct the raw source.
      const decoded = decodeString(gap.replace(/\r\n|\r/g, "\n"));
      if (gap.split(/\r\n|\r|\n/).length !== decoded.split(/\r\n|\r|\n/).length)
        return false;
    }
    previousEnd = last.end;
    const previous = carriers.get(line);
    // With only a formatted carrier, keep rendering and raw plain copy correct.
    // Host rich-paste normalization can double a display line's internal marks
    // (e.g. <em>*x*</em>). One source cannot also be the decoded rich-copy text;
    // this is a known limit, not a reason for native fallback.
    if (
      !previous ||
      (nth(segments, previous.segment).marked && !segment.marked)
    )
      carriers.set(line, part);
  }
  for (let i = 0; i < starts.length; i++) {
    const carrier = carriers.get(nth(starts, i));
    if (!carrier) return false;
    carrier.piece = { ...carrier.piece, source: nth(text, i) };
  }
  return true;
}

function mappedIndex(
  spans: readonly MathSpan[],
  segments: Segment[],
  content: string,
  lines: Uint32Array,
  prefixes: Map<number, number>,
  tree: Root,
  emoji: readonly string[] = [],
): MathIndex {
  const edges = breakEdges(content, lines, prefixes, tree);
  const names = new Set(emoji);
  // Same lookahead, case comparison and overlap skipping as host emojiMatches.
  // Registration order cannot matter: an intersecting earlier renderer must
  // never suppress our anchor while leaving its dependent hide pieces active.
  const conflicts = names.size
    ? segments.map((segment) => emojiMatches(segment.text, names))
    : null;
  const counts = new Map<string, number>();
  for (const segment of segments)
    counts.set(segment.text, (counts.get(segment.text) ?? 0) + 1);
  const mapped = spans.map((span) => {
    const touched: MappedPiece[] = [];
    segments.forEach((segment, index) => {
      const positions = segment.positions;
      const start = positions.findIndex(
        (p) => p.start < span.end && p.end > span.start,
      );
      if (start < 0) return;
      let end = start + 1,
        next = positions[end];
      while (next && next.start < span.end && next.end > span.start)
        next = positions[++end];
      touched.push({
        segment: index,
        piece: {
          start,
          end,
          role: "hide",
          source: "",
          joinBefore: false,
          joinAfter: false,
          span,
        },
      });
    });
    if (
      conflicts &&
      touched.some((t) =>
        nth(conflicts, t.segment).some(
          (r) => t.piece.start < r.end && t.piece.end > r.start,
        ),
      )
    )
      return [];
    // Spoilers protect concealment. Other rich marks only affect preference:
    // an equation with no unformatted piece still typesets in its wrapper.
    if (touched.some((t) => nth(segments, t.segment).spoiler)) return [];
    const plain = touched.filter((t) => !nth(segments, t.segment).marked);
    const unique = (part: MappedPiece) =>
      counts.get(nth(segments, part.segment).text) === 1;
    const body = (part: MappedPiece) => {
      const positions = nth(segments, part.segment).positions;
      return (
        span.delimiter !== "$$" ||
        (nth(positions, part.piece.start).start < span.end - 2 &&
          nth(positions, part.piece.end - 1).end > span.start + 2)
      );
    };
    const anchor =
      plain.find(unique) ??
      touched.find(unique) ??
      plain.find(body) ??
      touched.find(body) ??
      plain[0] ??
      touched[0];
    if (!anchor || !copySources(span, touched, segments, content, lines, edges))
      return [];
    anchor.piece = { ...anchor.piece, role: "render" };
    return touched;
  });
  // Only colliding hide pieces need a draw outcome. Cache the UI-observable
  // result per span, not the cloned DOM, across both consistency rules/passes.
  const outcomes = new Map<MathSpan, string>();
  const outcome = (span: MathSpan) => {
    let key = outcomes.get(span);
    if (key === undefined) {
      const drawn = render(
        span.tex,
        span.display,
        span.display ? { fleqn: true } : undefined,
      );
      key = JSON.stringify(
        drawn.ok ? ["ok"] : ["failed", span.delimiter === "$", drawn.message],
      );
      outcomes.set(span, key);
    }
    return key;
  };
  const samePiece = (
    a: SegmentPiece,
    b: SegmentPiece,
    joins = true,
  ): boolean => {
    if (a.role !== b.role || a.source !== b.source) return false;
    if (joins && (a.joinBefore !== b.joinBefore || a.joinAfter !== b.joinAfter))
      return false;
    if (a.span === b.span) return true;
    if (a.role === "render")
      return (
        a.span.source === b.span.source &&
        a.span.tex === b.span.tex &&
        a.span.display === b.span.display &&
        a.span.delimiter === b.span.delimiter
      );
    return outcome(a.span) === outcome(b.span);
  };
  // The host identifies a piece by its full segment and matched substring.
  // Otherwise-equivalent hidden aliases may conservatively share fewer joins:
  // only keep a flag that is safe at every indistinguishable occurrence. This
  // preserves formatted displays with repeated $$ without ever hiding prose.
  const hidden = new Map<string, Map<string, MappedPiece[]>>();
  for (const pieces of mapped)
    for (const part of pieces) {
      if (part.piece.role !== "hide") continue;
      const text = nth(segments, part.segment).text,
        match = text.slice(part.piece.start, part.piece.end);
      const matches = hidden.get(text) ?? new Map<string, MappedPiece[]>();
      const group = matches.get(match) ?? [];
      group.push(part);
      matches.set(match, group);
      hidden.set(text, matches);
    }
  for (const matches of hidden.values())
    for (const group of matches.values()) {
      const first = nth(group, 0).piece;
      if (
        group.every(
          ({ piece }) =>
            piece.joinBefore === first.joinBefore &&
            piece.joinAfter === first.joinAfter,
        )
      )
        continue;
      if (!group.every(({ piece }) => samePiece(piece, first, false))) continue;
      const joinBefore = group.every(({ piece }) => piece.joinBefore),
        joinAfter = group.every(({ piece }) => piece.joinAfter);
      for (const part of group)
        part.piece = { ...part.piece, joinBefore, joinAfter };
    }
  const sameList = (a: SegmentPiece[], b: SegmentPiece[]) =>
    a.length === b.length &&
    a.every((piece, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        piece.start === other.start &&
        piece.end === other.end &&
        samePiece(piece, other)
      );
    });
  const dropped = new Set<number>();
  let lists: SegmentPiece[][] = [];
  for (;;) {
    lists = segments.map(() => []);
    mapped.forEach((pieces, index) => {
      if (!dropped.has(index))
        for (const { segment, piece } of pieces)
          nth(lists, segment).push(piece);
    });
    const groups = new Map<string, number[]>();
    segments.forEach((s, i) => {
      const group = groups.get(s.text) ?? [];
      group.push(i);
      groups.set(s.text, group);
    });
    const bad = new Set<MathSpan>();
    for (const group of groups.values()) {
      const first = nth(lists, nth(group, 0));
      if (group.some((i) => !sameList(nth(lists, i), first)))
        for (const i of group)
          for (const piece of nth(lists, i)) bad.add(piece.span);
    }
    // Two equal matched substrings inside one segment are indistinguishable
    // to InlineRenderer.component. Drop all implicated spans, not just a piece.
    lists.forEach((pieces, index) => {
      const byMatch = new Map<string, SegmentPiece[]>();
      for (const piece of pieces) {
        const text = nth(segments, index).text.slice(piece.start, piece.end);
        const group = byMatch.get(text) ?? [];
        group.push(piece);
        byMatch.set(text, group);
      }
      for (const group of byMatch.values()) {
        const first = nth(group, 0);
        if (group.some((piece) => !samePiece(piece, first)))
          for (const piece of group) bad.add(piece.span);
      }
    });
    if (!bad.size) break;
    spans.forEach((span, index) => {
      if (bad.has(span)) dropped.add(index);
    });
  }
  const byText = new Map<string, readonly SegmentPiece[]>();
  segments.forEach((segment, i) => {
    byText.set(
      segment.text,
      Object.freeze(nth(lists, i).map((p) => Object.freeze(p))),
    );
  });
  const anchored = new Set<MathSpan>();
  for (const pieces of lists)
    for (const piece of pieces)
      if (piece.role === "render") anchored.add(piece.span);
  return Object.freeze({
    spans: Object.freeze([...spans]),
    drawn: Object.freeze(spans.filter((span) => anchored.has(span))),
    pieces: (text: string) => byText.get(text) ?? none,
  });
}

/** Language policy shared by the lexer, fence renderer, and lint tool. */
export function fenceMode(language: string): FenceMode | null {
  const name = language.trim().toLowerCase();
  return name === "math" || name === "katex"
    ? "math"
    : name === "latex" || name === "tex"
      ? "latex"
      : null;
}

function terminalLiteral(tree: Root, end: number): Nodes | undefined {
  let result: Nodes | undefined;
  function visit(node: Nodes) {
    const at = range(node);
    if (literal.has(node.type)) {
      if (at.start <= end && at.end >= end) result = node;
      return;
    }
    if ("children" in node)
      for (const child of node.children) visit(child as Nodes);
  }
  visit(tree);
  return result;
}

function unclosedFence(node: Nodes, content: string): boolean {
  if (node.type !== "code" || !fenceMode(node.lang ?? "")) return false;
  const at = range(node),
    raw = content.slice(at.start, at.end);
  const opener = /^(`{3,}|~{3,})/.exec(raw)?.[0];
  if (!opener) return false;
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines.length === 1) return true;
  let last = nth(lines, lines.length - 1);
  const lineStart = content.lastIndexOf("\n", at.start - 1) + 1;
  const quotes = content.slice(lineStart, at.start).match(/>/g)?.length ?? 0;
  for (let i = 0; i < quotes; i++)
    last = last.replace(/^[ \t]{0,3}>[ \t]?/, "");
  return !new RegExp(
    `^[ \\t]{0,3}${opener[0]}{${opener.length},}[ \\t]*$`,
  ).test(last);
}

function analyze(content: string, options: DetectOptions): Analysis {
  if (content.length > 100_000) return emptyAnalysis;
  const key = `${options.singleDollar ? "1" : "0"}:${JSON.stringify(options.references ?? null)}:${content}`;
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  let value: Analysis;
  try {
    const { tree, offered, cuts, unknown, bareLink, lines, prefixes } =
      hostStructure(content, options.references);
    const parity = escapeParity(content);
    const runs = scansIn(
      tree,
      content,
      options,
      prefixes,
      cuts,
      unknown,
      parity,
      lines,
    );
    const spans = runs.flatMap((run) => run.result.spans).slice(0, 500);
    const unclosed = runs.flatMap((run) =>
      run.result.open ? [Object.freeze(run.result.open)] : [],
    );
    const terminal = terminalLiteral(tree, content.trimEnd().length);
    let inside = terminal ? unclosedFence(terminal, content) : false;
    const last = runs.at(-1);
    if (
      !terminal &&
      !bareLink &&
      last &&
      !content.slice(last.end).trim() &&
      !/\n[ \t]*\n/.test(content.slice(last.start).replace(/\r\n|\r/g, "\n"))
    ) {
      const tail =
        last.end === content.length
          ? last.result
          : scan(
              content,
              last.start,
              content.length,
              options,
              prefixes,
              parity,
              lines,
              last.containerStart,
            );
      inside = tail.open !== null;
    }
    const index = !spans.length
      ? empty
      : bareLink
        ? Object.freeze({
            spans: Object.freeze(spans),
            drawn: empty.drawn,
            pieces: empty.pieces,
          })
        : mappedIndex(
            spans,
            offered,
            content,
            lines,
            prefixes,
            tree,
            options.references?.emoji,
          );
    value = { index, unclosed: Object.freeze(unclosed), inside };
  } catch {
    value = emptyAnalysis;
  }
  cache.set(key, value);
  if (cache.size > 256) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

export function indexMessage(
  content: string,
  options: DetectOptions,
): MathIndex {
  if (content.length > 100_000) return empty;
  if (negative.has(content)) {
    negative.delete(content);
    negative.add(content);
    return empty;
  }
  if (!/\$|\\\(|\\\[|\\begin/.test(content)) {
    negative.add(content);
    if (negative.size > 256) {
      const oldest = negative.values().next().value;
      if (oldest !== undefined) negative.delete(oldest);
    }
    return empty;
  }
  return analyze(content, options).index;
}

export function insideMath(before: string): boolean {
  if (!/\$|\\\(|\\\[|\\begin|`{3}|~{3}/.test(before)) return false;
  return analyze(before, { singleDollar: true }).inside;
}

/** Internal lint data from the same lexer; not a separate delimiter grammar. */
export function unclosedMath(content: string): readonly OpenMath[] {
  if (!/\$|\\\(|\\\[|\\begin/.test(content)) return [];
  return analyze(content, { singleDollar: true }).unclosed;
}
