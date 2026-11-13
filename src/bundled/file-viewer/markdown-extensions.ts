import type { Root } from "mdast";
import type { Plugin } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import { MAX_RENDER_CHARS, required } from "./markdown-limits";
export { ALERT_TYPES } from "./markdown-schema";

export type FrontMatterEntry = Readonly<{ key: string; value: string }>;

type MarkdownNode = {
  type: string;
  value?: string | undefined;
  lang?: string | null;
  meta?: string | null;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: {
    start: { offset?: number | undefined; line: number };
    end: { offset?: number | undefined; line: number };
  };
};

const rawOf = (node: MarkdownNode, source: string): string =>
  source.slice(
    node.position?.start.offset ?? 0,
    node.position?.end.offset ?? 0,
  );
const mathCode = (value: string): MarkdownNode => ({
  type: "code",
  lang: "math",
  value,
});
const literalMath = (node: MarkdownNode, source: string): MarkdownNode => ({
  type: "text",
  value: rawOf(node, source),
});

function standaloneInline(node: MarkdownNode, source: string): boolean {
  if (
    node.type !== "inlineMath" ||
    node.position?.start.line !== node.position?.end.line
  )
    return false;
  const raw = rawOf(node, source);
  if (!/^\$\$(?!\$)[\s\S]*[^$]\$\$$/.test(raw)) return false;
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? 0;
  let lineStart = start;
  while (lineStart > 0) {
    const char = source.charAt(lineStart - 1);
    if (char === "\n" || char === "\r") break;
    if (!/[ \t>0-9.+*)-]/.test(char)) return false;
    lineStart--;
  }
  for (let at = end; at < source.length; at++) {
    const char = source.charAt(at);
    if (char === "\n" || char === "\r") break;
    if (char !== " " && char !== "\t") return false;
  }
  // Inspect only this physical line. A quote/list prefix is structural, while
  // other same-line prose keeps the equation literal.
  return /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?$/.test(
    source.slice(lineStart, start),
  );
}

/** The tokenizer protects TeX from Markdown interpretation. Only closed,
 * standalone $$ syntax is promoted; all inline syntax is restored verbatim. */
function prepareMath(tree: MarkdownNode, source: string): void {
  const stack = [tree];
  while (stack.length) {
    const parent = required(stack.pop());
    if (!parent.children) continue;
    const children: MarkdownNode[] = [];
    for (const node of parent.children) {
      if (node.type === "math") {
        const raw = rawOf(node, source);
        const lines = raw.split(/\r\n?|\n/);
        const closed =
          /^\$\$(?!\$)/.test(required(lines[0])) &&
          lines.length > 1 &&
          /^[ \t]*(?:>[ \t]*)*\$\$[ \t]*$/.test(required(lines.at(-1)));
        if (closed) {
          // remark-math calls same-line opening text 'meta'; here it's TeX.
          children.push(
            mathCode((node.meta ? `${node.meta}\n` : "") + (node.value ?? "")),
          );
        } else {
          children.push({
            type: "paragraph",
            children: [{ type: "text", value: raw }],
          });
        }
        continue;
      }
      if (node.type === "paragraph") {
        let pending: MarkdownNode[] = [];
        let afterMath = false;
        const flush = () => {
          if (
            pending.some(
              (child) => child.type !== "text" || child.value?.trim(),
            )
          )
            children.push({ ...node, children: pending });
          pending = [];
        };
        for (const inline of node.children ?? []) {
          if (standaloneInline(inline, source)) {
            const previous = pending.at(-1);
            if (previous?.type === "text")
              previous.value = previous.value?.replace(/(?:\r\n?|\n)$/, "");
            flush();
            children.push(mathCode(inline.value ?? ""));
            afterMath = true;
          } else {
            const child =
              inline.type === "inlineMath"
                ? literalMath(inline, source)
                : inline;
            if (afterMath && child.type === "text")
              child.value = child.value?.replace(/^(?:\r\n?|\n)/, "");
            afterMath = false;
            pending.push(child);
          }
        }
        flush();
        continue;
      }
      children.push(
        node.type === "inlineMath" ? literalMath(node, source) : node,
      );
    }
    parent.children = children;
    for (const child of children) {
      if (child.type === "paragraph") {
        for (const inline of child.children ?? [])
          if (inline.children) stack.push(inline);
      } else if (child.children) stack.push(child);
    }
  }
}

/** Only mdast blockquotes outside another quote may acquire alert metadata.
 * The temporary marker cannot occur in raw source and is removed after reparse. */
function prepareAlerts(tree: MarkdownNode, marker: string): void {
  const stack = [{ node: tree, insideQuote: false }];
  while (stack.length) {
    const { node, insideQuote } = required(stack.pop());
    const quote = node.type === "blockquote";
    const paragraph = node.children?.[0];
    const first = paragraph?.children?.[0];
    if (
      quote &&
      !insideQuote &&
      paragraph?.type === "paragraph" &&
      first?.type === "text"
    ) {
      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](\r?\n|$)/i.exec(
        first.value ?? "",
      );
      const next = paragraph.children?.[1];
      if (match && (match[2] || !next || next.type === "break")) {
        first.value = required(first.value).slice(match[0].length);
        if (!first.value) required(paragraph.children).shift();
        if (!match[2] && next?.type === "break")
          required(paragraph.children).shift();
        if (!paragraph.children?.length) required(node.children).shift();
        node.data = {
          ...node.data,
          hName: "div",
          hProperties: {
            [marker]: `alert:${required(match[1]).toLowerCase()}`,
          },
        };
      }
    }
    for (const child of node.children ?? [])
      stack.push({ node: child, insideQuote: insideQuote || quote });
  }
}

export function flatFrontMatter(
  value: string,
): readonly FrontMatterEntry[] | undefined {
  const entries: FrontMatterEntry[] = [];
  for (const line of value.split(/\r\n?|\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!match || entries.length === 50) return undefined;
    let scalar = required(match[2]).trim();
    if (scalar.startsWith('"') || scalar.startsWith("'")) {
      const quoted =
        scalar[0] === '"' ? /^"(?:[^"\\]|\\.)*"$/ : /^'(?:[^']|'')*'$/;
      if (!quoted.test(scalar)) return undefined;
      scalar = scalar.slice(1, -1);
    } else if (
      /^[[\]{}|>&*!]/.test(scalar) ||
      /^-(?:\s|$)/.test(scalar) ||
      /:\s/.test(scalar)
    ) {
      return undefined;
    }
    entries.push({ key: required(match[1]), value: scalar });
  }
  return entries;
}

/** Blank only complete, flat leading YAML. Keeping each offset and line ending
 * lets the whole-file reader index headings and slice parts from this text. */
export function prepareMarkdownText(text: string): Readonly<{
  text: string;
  frontMatter?: readonly FrontMatterEntry[];
}> {
  const opening = /^(?:\ufeff)?---[ \t]*(?:\r\n?|\n)/.exec(text);
  if (!opening) return { text };
  const fence = /^---[ \t]*(?=\r?$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(text);
  if (!closing) return { text };
  const end = closing.index + closing[0].length;
  if (end > MAX_RENDER_CHARS) return { text };
  const frontMatter = flatFrontMatter(
    text.slice(opening[0].length, closing.index).replace(/(?:\r\n?|\n)$/, ""),
  );
  if (frontMatter === undefined) return { text };
  return {
    text:
      text.slice(0, end).replace(/[^\r\n]+/g, (run) => " ".repeat(run.length)) +
      text.slice(end),
    frontMatter,
  };
}

/** Raw HTML cannot forge this marker: allocation scans its saved spellings
 * once before adding the generated property to Markdown alert nodes. */
export function generatedMarkdownMarker(source: string): string {
  const claimed = new Set(
    [...source.matchAll(/data-mdv-generated(\d+)/gi)].map((match) => match[1]),
  );
  let index = 0;
  while (claimed.has(String(index))) index++;
  return `dataMdvGenerated${index}`;
}

/** File-specific Markdown grammar. Other Markdown surfaces do not install it. */
export const remarkFileMarkdown: Plugin<[], Root> = function () {
  this.use(remarkFrontmatter, ["yaml"]).use(remarkMath);
  return (tree, file) => {
    const first = tree.children[0];
    if (first?.type === "yaml") {
      if (flatFrontMatter(first.value) !== undefined) tree.children.shift();
      else
        tree.children[0] = {
          type: "code",
          lang: "yaml",
          value: first.value,
          ...(first.position ? { position: first.position } : {}),
        };
    }
    const source = String(file.value ?? "");
    const markdown = tree as unknown as MarkdownNode;
    prepareMath(markdown, source);
    prepareAlerts(markdown, generatedMarkdownMarker(source));
  };
};
