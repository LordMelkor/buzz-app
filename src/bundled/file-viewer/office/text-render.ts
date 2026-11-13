import { required } from "./required";
import type { Element, ElementContent, Root } from "hast";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "../office-types";
import type { OfficeDocument } from "../office-types";
import { highlight } from "../highlight";
const highlighted = (value: string, language?: string) =>
  highlight(value, language).children.filter((node) => node.type !== "doctype");
import { parseOfficeTree } from "../office-parse";
import { PART_CHARS } from "../document-parts";
import { officeBudget } from "./yield";
import { OfficeFailure } from "./zip";

export type Dialect = "rst" | "adoc" | "tex";
export type Node = ElementContent;
export type InlineReader = (
  value: string,
  depth: number,
  notes: boolean,
) => Promise<Node[]>;
export class RenderLimit extends Error {}

/** Terminal truncation admits complete outer blocks, including their notes.
 * Source cursors and small scratch strings can advance while building; only
 * successful blocks enter the returned tree. No later block follows overflow. */
export class TextRender {
  private state: "active" | "truncated" = "active";
  private used = 0;
  private readonly heights = new WeakMap<object, number>();
  private readonly notes = new Map<string, { number: number; item: Element }>();
  private noteList: { list: Element; section: Element } | undefined;
  private readonly pause;
  readonly blocks: Node[] = [];
  readonly headingStyles = new Map<string, number>();
  readonly attributes = new Map<string, string>();
  readonly definitions = new Map<
    string,
    { start: number; end: number; label: string }
  >();
  readonly automaticNotes: string[] = [];
  private metadata = 0;
  private noteNumber = 0;

  constructor(
    readonly signal: AbortSignal,
    private readonly isCommunityMedia: (url: string) => boolean = () => false,
  ) {
    this.pause = officeBudget(signal);
  }
  get remaining(): number {
    return Math.max(0, MAX_RENDER_CHARS - this.used);
  }
  get active(): boolean {
    return this.state === "active";
  }
  ensure(count: number): void {
    if (count > this.remaining) throw new RenderLimit();
  }
  charge(count: number): void {
    this.ensure(count);
    this.used += count;
  }
  depth(depth: number): void {
    if (depth > MAX_RENDER_DEPTH - 8)
      throw new OfficeFailure("too-large", "Text document nesting limit");
  }
  retain(count: number): void {
    if (count > MAX_RENDER_CHARS - this.metadata) throw new RenderLimit();
    this.metadata += count;
  }
  async tick(force = false): Promise<void> {
    const pending = this.pause(force);
    if (pending) await pending;
  }
  text(value: string): Node {
    this.charge(value.length + 1);
    return { type: "text", value };
  }
  el(
    tagName: string,
    children: Node[] = [],
    properties: Element["properties"] = {},
  ): Element {
    let height = 0;
    for (const child of children)
      height = Math.max(height, 1 + (this.heights.get(child) ?? 0));
    if (height >= MAX_RENDER_DEPTH)
      throw new OfficeFailure("too-large", "Text document tree depth limit");
    let cost = 1;
    for (const value of Object.values(properties))
      cost +=
        typeof value === "string"
          ? value.length
          : Array.isArray(value)
            ? value.join(" ").length
            : 1;
    this.charge(cost);
    const node: Element = { type: "element", tagName, properties, children };
    this.heights.set(node, height);
    return node;
  }
  math(value: string): Element {
    return this.el("code", [this.text(value)], { dataMath: "inline" });
  }
  code(value: string, language?: string): Element {
    this.ensure(value.length + 3);
    language = language?.toLowerCase();
    const normalized: Record<string, string> = {
      js: "javascript",
      ts: "typescript",
      py: "python",
      sh: "bash",
      csharp: "cs",
      "c++": "cpp",
    };
    language = normalized[language ?? ""] ?? language;
    // Highlighting allocates a syntax tree inside the dependency. Keep that
    // call within one ordinary reader part; longer code remains exact text.
    const children =
      value.length <= PART_CHARS && language && language !== "math"
        ? highlighted(value, language)
        : [this.text(value)];
    if (value.length <= PART_CHARS && language && language !== "math") {
      const pending: Node[] = [...children],
        ordered: Node[] = [];
      while (pending.length) {
        const node = required(pending.pop());
        ordered.push(node);
        this.charge(node.type === "text" ? node.value.length + 1 : 1);
        if (node.type === "element")
          for (const child of node.children) pending.push(child);
      }
      for (let at = ordered.length - 1; at >= 0; at--) {
        const node = required(ordered[at]);
        if (node.type === "element") {
          let height = 0;
          for (const child of node.children)
            height = Math.max(height, 1 + (this.heights.get(child) ?? 0));
          this.heights.set(node, height);
        }
      }
    }
    return this.el(
      "pre",
      [this.el("code", children, language ? { dataLanguage: language } : {})],
      language === "math" ? { dataMath: "display" } : {},
    );
  }
  image(url: string, alt = ""): Element {
    return this.el("img", [], {
      ...(this.isCommunityMedia(url) ? { src: url } : {}),
      alt: alt || url,
    });
  }
  async note(
    key: string,
    value: string,
    inline: InlineReader,
    depth: number,
  ): Promise<Element> {
    let saved = this.notes.get(key);
    if (!saved) {
      const number = this.notes.size + 1;
      const item = this.el(
        "li",
        [this.el("p", await inline(value, depth + 1, false))],
        { id: `mdv-note-${number}` },
      );
      saved = { number, item };
      this.notes.set(key, saved);
      if (!this.noteList) {
        const list = this.el("ol");
        this.noteList = {
          list,
          section: this.el("section", [list], { className: ["footnotes"] }),
        };
      }
      this.noteList.list.children.push(item);
    }
    return this.el("sup", [
      this.el("a", [this.text(String(saved.number))], {
        href: `#mdv-note-${saved.number}`,
      }),
    ]);
  }
  nextNote(): string {
    return `inline-${++this.noteNumber}`;
  }
  async admit(build: () => Promise<Node[]>): Promise<void> {
    if (!this.active) return;
    const noteCount = this.notes.size;
    try {
      for (const block of await build()) this.blocks.push(block);
    } catch (error) {
      if (!(error instanceof RenderLimit)) throw error;
      this.state = "truncated";
      let kept = 0;
      for (const key of this.notes.keys())
        if (kept++ >= noteCount) this.notes.delete(key);
      if (!noteCount) this.noteList = undefined;
      else required(this.noteList).list.children.length = noteCount;
    }
  }
  finish(): OfficeDocument {
    const tree: Root = {
      type: "root",
      children: this.noteList
        ? [...this.blocks, this.noteList.section]
        : this.blocks,
    };
    return {
      family: "document",
      parsed: parseOfficeTree(tree),
      charts: [],
      ...(this.active ? {} : { truncated: true }),
    };
  }
}

/** Small chunks bound temporary strings as well as the returned HAST. */
export class TextBuffer {
  private size = 0;
  private pending = "";
  private readonly chunks: string[] = [];
  constructor(private readonly render: TextRender) {}
  get length(): number {
    return this.size;
  }
  add(value: string): void {
    this.render.ensure(this.size + value.length + 1);
    this.size += value.length;
    this.pending += value;
    if (this.pending.length >= 8192) {
      this.chunks.push(this.pending);
      this.pending = "";
    }
  }
  range(source: string, start: number, end: number): void {
    this.render.ensure(this.size + end - start + 1);
    for (let at = start; at < end; at += 8192)
      this.add(source.slice(at, Math.min(end, at + 8192)));
  }
  value(): string {
    return this.chunks.join("") + this.pending;
  }
}

/** Two offsets, not an array of line objects proportional to a 50 MiB file. */
export class TextLines {
  at: number;
  end = 0;
  constructor(
    readonly source: string,
    at = 0,
    readonly stop = source.length,
  ) {
    this.at = at;
    this.seek(at);
  }
  get next(): number {
    return this.end < this.stop ? this.end + 1 : this.end;
  }
  get done(): boolean {
    return this.at >= this.stop;
  }
  seek(at: number): void {
    this.at = at;
    const end = this.source.indexOf("\n", at);
    this.end = end < 0 ? this.stop : Math.min(end, this.stop);
  }
  advance(): void {
    this.seek(this.next);
  }
  prefix(): string {
    return this.source.slice(this.at, Math.min(this.end, this.at + 256));
  }
  body(render: TextRender): string {
    render.ensure(this.end - this.at + 1);
    return this.source.slice(this.at, this.end);
  }
  peek(render: TextRender): string {
    const start = this.next,
      found = this.source.indexOf("\n", start),
      end = found < 0 ? this.stop : Math.min(found, this.stop);
    render.ensure(end - start + 1);
    return this.source.slice(start, end);
  }
}

export const alerts: Readonly<Record<string, string>> = {
  note: "note",
  tip: "tip",
  important: "important",
  warning: "warning",
  caution: "caution",
  danger: "caution",
  attention: "warning",
  hint: "tip",
  error: "caution",
};
export const indent = (value: string): number => {
  let count = 0;
  for (const char of value) {
    if (char === " ") count++;
    else if (char === "\t") count += 4 - (count % 4);
    else break;
  }
  return count;
};
export function dedent(value: string, amount: number): string {
  let at = 0,
    columns = 0;
  while (
    at < value.length &&
    columns < amount &&
    (value[at] === " " || value[at] === "\t")
  )
    columns += value[at++] === "\t" ? 4 - (columns % 4) : 1;
  return value.slice(at);
}
