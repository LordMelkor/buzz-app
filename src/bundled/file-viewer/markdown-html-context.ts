// Source spans and a bounded tokenizer state, never a whole-document HTML tree.
import { parseFragment } from "parse5";
import {
  MAX_RENDER_CHARS,
  MAX_RENDER_DEPTH,
  required,
} from "./markdown-limits";
import { fenceLine } from "./markdown-fences";
import type { FenceState } from "./markdown-fences";
import { startsBlankHtmlBlock } from "./markdown-html";

export type HtmlTag = Readonly<{ name: string; start: number; end: number }>;
type Pending = {
  start: number;
  kind: "start" | "bang" | "name" | "tag" | "comment" | "declaration";
  name: string;
  closing?: boolean;
  quote?: string | undefined;
  dashes?: number;
  raw?: string;
};
type Flow = Readonly<{ start: number; end: number; state: FenceState }>;
type Ticks = Readonly<{
  from: number;
  end: number;
  last: ReadonlyMap<number, number>;
}>;
export type HtmlState = Readonly<{
  stack: readonly HtmlTag[];
  pending?: Readonly<Pending>;
  deep?: boolean;
  literalEnd?: number;
  ticks?: Ticks;
  dollars?: Ticks;
  flow?: Flow;
}>;
const voids = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);
const rawTags = new Set(["script", "style", "textarea", "title"]);
const closesParagraph = new Set(
  "address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul".split(
    " ",
  ),
);

const nextLine = (text: string, at: number) =>
  at + (text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1);
function physicalLine(
  text: string,
  start: number,
): { end: number; next: number } {
  const breaks = /[\r\n]/g;
  breaks.lastIndex = start;
  const end = breaks.exec(text)?.index ?? text.length;
  return { end, next: end < text.length ? nextLine(text, end) : end };
}
function flowAt(
  text: string,
  at: number,
  previous: Flow | undefined,
  markdown: boolean,
): Flow {
  if (previous && at >= previous.start && at < previous.end) return previous;
  let start = at;
  while (start > 0 && text[start - 1] !== "\r" && text[start - 1] !== "\n")
    start--;
  const line = physicalLine(text, start);
  const before = previous
    ? {
        ...previous.state,
        ...(start > previous.end ? { paragraph: false } : {}),
      }
    : { owners: [] };
  return {
    start,
    end: line.next,
    state: fenceLine(text.slice(start, line.end), before, !markdown).after,
  };
}
function htmlBlock(line: string): boolean {
  return (
    startsBlankHtmlBlock(line) ||
    /^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Za-z])/.test(line) ||
    /^ {0,3}<(?:script|style|pre|textarea)(?:[\t >]|\/>|$)/i.test(line)
  );
}

/** Successful lookaheads are disjoint because their whole code span is skipped.
 * One unsuccessful lookahead records last occurrences by run length. Later
 * unmatched openers reuse that immutable paragraph cache instead of rescanning
 * the suffix. There is no per-run or per-line retained inventory. */
function codeEnd(
  text: string,
  from: number,
  size: number,
  marker: string,
  flow: Flow,
  cached?: Ticks,
): { end?: number | undefined; ticks?: Ticks | undefined } {
  if (
    cached &&
    from >= cached.from &&
    from < cached.end &&
    (cached.last.get(size) ?? -1) < from
  )
    return { ticks: cached };
  const last = new Map<number, number>();
  let state = flow.state,
    at = from;
  for (; at < text.length; at++) {
    if (text[at] === "\r" || text[at] === "\n") {
      const start = nextLine(text, at),
        line = physicalLine(text, start);
      const step = fenceLine(text.slice(start, line.end), state);
      const changed =
        state.owners.length !== step.after.owners.length ||
        state.owners.some(
          (owner, index) => owner.id !== step.after.owners[index]?.id,
        );
      if (
        step.code ||
        !step.after.paragraph ||
        changed ||
        htmlBlock(step.body)
      ) {
        at = start;
        break;
      }
      state = step.after;
      at = start - 1;
    } else if (text[at] === marker) {
      let end = at + 1;
      while (text[end] === marker) end++;
      const length = end - at;
      if (length === size) return { end, ticks: cached };
      last.set(length, at);
      at = end - 1;
    }
  }
  return { ticks: { from, end: at, last } };
}

/** Consume only [start,end). Snapshots share immutable stacks; pending tokens
 * resume at the next range without rescanning their possibly long attributes. */
export type HtmlOpening = (tag: HtmlTag, ancestors: readonly HtmlTag[]) => void;

export function htmlLine(
  text: string,
  start: number,
  end: number,
  state: HtmlState,
  markdown = false,
  opening?: HtmlOpening,
): HtmlState {
  if (state.deep) return state;
  let stack = state.stack,
    pending = state.pending ? { ...state.pending } : undefined,
    deep = false;
  let literalEnd = markdown ? state.literalEnd : undefined,
    ticks = state.ticks,
    dollars = state.dollars,
    flow = state.flow;
  function optional(
    names: readonly string[],
    boundaries: readonly string[],
  ): void {
    let floor = stack.length - 1;
    while (floor >= 0 && !boundaries.includes(required(stack[floor]).name))
      floor--;
    const at = stack.findIndex(
      (tag, index) => index > floor && names.includes(tag.name),
    );
    if (at >= 0) stack = stack.slice(0, at);
  }
  function finish(at: number): void {
    const tag = required(pending);
    pending = undefined;
    if (tag.closing) {
      const index = stack.map((tag) => tag.name).lastIndexOf(tag.name);
      if (index >= 0) stack = stack.slice(0, index);
      return;
    }
    if (closesParagraph.has(tag.name))
      optional(["p"], ["table", "td", "th", "button"]);
    if (tag.name === "li") optional(["li"], ["ol", "ul", "menu"]);
    if (tag.name === "dt" || tag.name === "dd") optional(["dt", "dd"], ["dl"]);
    if (["thead", "tbody", "tfoot", "tr", "td", "th"].includes(tag.name))
      optional(["colgroup"], ["table"]);
    if (["thead", "tbody", "tfoot"].includes(tag.name))
      optional(["thead", "tbody", "tfoot", "tr", "td", "th"], ["table"]);
    if (tag.name === "tr")
      optional(["tr", "td", "th"], ["table", "thead", "tbody", "tfoot"]);
    if (tag.name === "td" || tag.name === "th")
      optional(["td", "th"], ["table", "tr"]);
    if (tag.name === "colgroup") optional(["colgroup"], ["table"]);
    if (tag.name === "option")
      optional(["option"], ["select", "datalist", "optgroup"]);
    if (tag.name === "optgroup") optional(["optgroup", "option"], ["select"]);
    opening?.({ name: tag.name, start: tag.start, end: at + 1 }, stack);
    if (voids.has(tag.name)) return;
    if (stack.length >= MAX_RENDER_DEPTH) {
      deep = true;
      return;
    }
    stack = [...stack, { name: tag.name, start: tag.start, end: at + 1 }];
  }
  for (let at = start; at < end && !deep; at++) {
    flow = flowAt(text, at, flow, markdown);
    const char = required(text[at]);
    if (!pending) {
      if (markdown && !rawTags.has(stack.at(-1)?.name ?? "")) {
        if (literalEnd !== undefined && at < literalEnd) {
          at = Math.min(end, literalEnd) - 1;
          continue;
        }
        literalEnd = undefined;
        if (
          char === "\\" &&
          /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[at + 1] ?? "")
        ) {
          literalEnd = at + 2;
          at = Math.min(end, literalEnd) - 1;
          continue;
        }
        if (char === "`" || char === "$") {
          let after = at + 1;
          while (text[after] === char) after++;
          const code = codeEnd(
            text,
            after,
            after - at,
            char,
            flow,
            char === "$" ? dollars : ticks,
          );
          if (char === "$") dollars = code.ticks;
          else ticks = code.ticks;
          literalEnd = code.end ?? after;
          at = Math.min(end, literalEnd) - 1;
          continue;
        }
      }
      if (char === "<")
        pending = {
          start: at,
          kind: "start",
          name: "",
          ...(rawTags.has(stack.at(-1)?.name ?? "")
            ? { raw: required(stack.at(-1)).name }
            : {}),
        };
      continue;
    }
    if (pending.kind === "comment") {
      if (char === ">" && (pending.dashes ?? 0) >= 2) pending = undefined;
      else
        pending.dashes =
          char === "-" ? Math.min(2, (pending.dashes ?? 0) + 1) : 0;
      continue;
    }
    if (pending.kind === "start") {
      if (char === "/" && !pending.closing) {
        pending.closing = true;
        continue;
      }
      if (!pending.raw && !pending.closing && char === "!") {
        pending.kind = "bang";
        pending.dashes = 0;
        continue;
      }
      if ((!pending.raw || pending.closing) && /[a-z]/i.test(char)) {
        pending.kind = "name";
        pending.name = char.toLowerCase();
        continue;
      }
      pending = undefined;
      if (char === "<") at--;
      continue;
    }
    if (pending.kind === "bang") {
      if (char === "-") {
        pending.dashes = (pending.dashes ?? 0) + 1;
        if (pending.dashes === 2) {
          pending.kind = "comment";
          pending.dashes = 0;
        }
        continue;
      }
      pending.kind = "declaration";
    }
    if (pending.kind === "name") {
      if (/[a-z\d-]/i.test(char)) {
        pending.name += char.toLowerCase();
        if (pending.name.length > 128) {
          deep = true;
          break;
        }
        if (pending.raw && !pending.raw.startsWith(pending.name))
          pending = undefined;
        continue;
      }
      if (
        !/[\t\n\r\f />]/.test(char) ||
        (pending.raw && pending.name !== pending.raw)
      ) {
        pending = undefined;
        if (char === "<") at--;
        continue;
      }
      pending.kind = "tag";
    }
    if (pending.quote) {
      if (char === pending.quote) pending.quote = undefined;
    } else if (char === '"' || char === "'") pending.quote = char;
    else if (char === ">") {
      if (pending.kind === "tag") finish(at);
      else pending = undefined;
    }
  }
  return {
    stack,
    ...(pending ? { pending } : {}),
    ...(deep ? { deep: true } : {}),
    ...(literalEnd === undefined ? {} : { literalEnd }),
    ...(ticks ? { ticks } : {}),
    ...(dollars ? { dollars } : {}),
    ...(flow ? { flow } : {}),
  };
}

/** Reopen ancestors with parser-decoded, escaped attributes. Synthetic copies
 * omit IDs so a document target belongs only to its original opening tag. */
export function htmlWrapper(
  text: string,
  state: HtmlState,
  oneLine = false,
): {
  open: string;
  close: string;
  size: number;
  deep?: boolean;
  unfinished?: boolean;
} {
  const empty = { open: "", close: "", size: 0 };
  if (
    state.deep ||
    state.stack.reduce((sum, tag) => sum + tag.end - tag.start, 0) >
      MAX_RENDER_CHARS
  )
    return { ...empty, deep: true };
  if (state.pending) return { ...empty, unfinished: true };
  let open = "",
    close = "";
  const escapeAttribute = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  for (const tag of state.stack) {
    const fragment = parseFragment(
      `<div${text.slice(tag.start + 1 + tag.name.length, tag.end - 1)}></div>`,
    );
    const element = fragment.childNodes.find(
      (node) => "tagName" in node && node.tagName === "div",
    );
    const attrs =
      element && "attrs" in element
        ? element.attrs.filter(
            (attr) => attr.name !== "id" && /^[^\s"'<>/=]+$/.test(attr.name),
          )
        : [];
    const rawOpening = `<${tag.name}${attrs.map((attr) => ` ${attr.name}="${escapeAttribute(attr.value)}"`).join("")}>${tag.name === "pre" ? "\n" : ""}`;
    // Tail continuations must not gain a physical line ending from attributes
    // or pre's first-newline compensation. HTML decodes these entities later.
    const opening = oneLine
      ? rawOpening.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;")
      : rawOpening;
    const closing = `</${tag.name}>`;
    if (
      open.length + close.length + opening.length + closing.length >
      MAX_RENDER_CHARS
    )
      return { ...empty, deep: true };
    open += opening;
    close = closing + close;
  }
  return { open, close, size: open.length + close.length };
}
