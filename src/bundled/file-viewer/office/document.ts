import { required } from "./required";
// Owner: Sigil (D20). Word/ODF rich documents, built as hast; never as HTML.
import type { Element as HastElement, ElementContent, Root } from "hast";
import type { Chart, OfficeDocument } from "../office-types";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "../office-types";
import { parseOfficeTree } from "../office-parse";
import { readChart } from "./chart";
import { chartAdmission } from "./chart-admission";
import type { OfficeInput } from "./load";
import { partPath } from "./package";
import type { Relationship } from "./package";
import {
  sourceAttr as attr,
  sourceChild as child,
  children,
  descendants,
} from "./xml";
import { OfficeFailure } from "./zip";

type Node = ElementContent;
type Inline = Node | { type: "pageBreak" };
type RunStyle = Partial<
  Record<
    | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "highlight"
    | "mono"
    | "hidden",
    boolean
  >
> & { position?: "sup" | "sub" | "normal" };
type WordStyle = {
  heading?: number | undefined;
  basedOn?: string | undefined;
  p?: Element | undefined;
  r: RunStyle;
};
type Field =
  | { phase: "instruction"; instruction: string }
  | { phase: "result"; href?: string | undefined };
type Fields = { stack: Field[]; instructions: number };
type NoteBodies = Record<
  "footnote" | "endnote",
  Map<string | undefined, Element>
>;
type OdfObject =
  | { kind: "chart"; source: Document; title?: string }
  | {
      kind: "math";
      node: Element;
      rendered?: { value: string; cost: number; height: number };
    }
  | { kind: "none" };
type Note = {
  key: string;
  number: number;
  part: string;
  body?: Element | undefined;
  id: string;
  content?: Node[];
};
class RenderLimit extends Error {}
type ListSpec = { key: string; level: number; tag: "ul" | "ol"; start: number };
const element = (
  tagName: string,
  content: Node[] = [],
  properties: HastElement["properties"] = {},
): HastElement => ({ type: "element", tagName, properties, children: content });
const text = (value: string): Node => ({ type: "text", value });
const isBlock = (node: Inline): node is HastElement =>
  node.type === "element" &&
  /^(?:p|h[1-6]|ul|ol|table|figure|blockquote)$/.test(node.tagName);
// Empty bookmarks and formatting wrappers do not make hidden text visible.
const hasVisibleContent = (nodes: readonly Inline[]): boolean =>
  nodes.some(
    (node) =>
      node.type === "pageBreak" ||
      (node.type === "text" && !!node.value) ||
      (node.type === "element" &&
        (["br", "img", "figure", "table", "li"].includes(node.tagName) ||
          hasVisibleContent(node.children))),
  );
const enabled = (node: Element | undefined): boolean =>
  !!node && !/^(?:0|false|off|none)$/i.test(attr(node, "val") ?? "true");
// Accept leading zeroes and long valid counts. Saturation keeps expansion
// finite; the existing work budget rejects any overflowing block.
const integer = (value: string | undefined, fallback = 1): number =>
  value !== undefined && /^\d+$/.test(value)
    ? Math.min(Number(value), Number.MAX_SAFE_INTEGER)
    : fallback;
const nonnegativeInteger = (value: string | undefined): number | undefined =>
  value !== undefined &&
  /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
function append<T>(target: T[], source: readonly T[]): void {
  for (const value of source) target.push(value);
}
const monospace = (font: string) =>
  /mono|courier|consolas|menlo|cascadia|fixed|source code|lucida console/i.test(
    font,
  );
const https = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

const wordContainers = new Set([
  "sdt",
  "sdtContent",
  "customXml",
  "ins",
  "moveTo",
]);

const headingByName = (name: string): number | undefined =>
  /^title$/i.test(name)
    ? 1
    : Number(/^heading\s*([1-6])$/i.exec(name)?.[1]) || undefined;

function styled(nodes: Inline[], style: RunStyle): Inline[] {
  const tags = [
    style.mono && "code",
    style.bold && "strong",
    style.italic && "em",
    style.underline && "u",
    style.strike && "del",
    style.position === "sup" && "sup",
    style.position === "sub" && "sub",
    style.highlight && "mark",
  ].filter(Boolean) as string[];
  if (!tags.length) return nodes;
  const out: Inline[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.length) {
      let value = run;
      for (const tag of tags) value = [element(tag, value)];
      append(out, value);
      run = [];
    }
  };
  for (const node of nodes) {
    if (node.type === "pageBreak" || isBlock(node)) {
      flush();
      out.push(node);
    } else run.push(node);
  }
  flush();
  return out;
}

function wordRunStyle(
  pr: Element | undefined,
  inherited: RunStyle = {},
): RunStyle {
  const out = { ...inherited };
  if (!pr) return out;
  for (const [name, key] of [
    ["b", "bold"],
    ["i", "italic"],
    ["u", "underline"],
    ["strike", "strike"],
    ["highlight", "highlight"],
    ["vanish", "hidden"],
  ] as const) {
    const value = child(pr, name);
    if (value) out[key] = enabled(value);
  }
  const position = attr(child(pr, "vertAlign"), "val");
  if (position)
    out.position =
      position === "superscript"
        ? "sup"
        : position === "subscript"
          ? "sub"
          : "normal";
  const fonts = child(pr, "rFonts"),
    font = attr(fonts, "ascii") ?? attr(fonts, "hAnsi");
  if (font) out.mono = monospace(font);
  return out;
}

// OOXML 17.7.3: an enabled vanish in a style toggles the inherited value;
// false leaves it unchanged. Direct run properties remain absolute above.
function wordStyle(inherited: RunStyle, patch: RunStyle): RunStyle {
  const { hidden, ...properties } = patch;
  return {
    ...inherited,
    ...properties,
    ...(hidden ? { hidden: !inherited.hidden } : {}),
  };
}

function odfRunStyle(
  pr: Element | undefined,
  inherited: RunStyle,
  fonts: ReadonlyMap<string, boolean>,
): RunStyle {
  const out = { ...inherited };
  if (!pr) return out;
  const weight = attr(pr, "font-weight"),
    italic = attr(pr, "font-style"),
    underline = attr(pr, "text-underline-style"),
    strike = attr(pr, "text-line-through-style");
  if (weight) out.bold = weight === "bold" || Number(weight) >= 600;
  if (italic) out.italic = italic === "italic" || italic === "oblique";
  if (underline) out.underline = underline !== "none";
  if (strike) out.strike = strike !== "none";
  const display = attr(pr, "display");
  if (display) out.hidden = display === "none";
  const background = attr(pr, "background-color");
  if (background) out.highlight = background !== "transparent";
  const position = attr(pr, "text-position");
  if (position)
    out.position = position.startsWith("super")
      ? "sup"
      : position.startsWith("sub")
        ? "sub"
        : "normal";
  const font = attr(pr, "font-name") ?? attr(pr, "font-family");
  if (font) out.mono = fonts.get(font) ?? monospace(font);
  return out;
}

/** All part reads use OfficePackage.xml: the shared XML guard and cache. */
export function readDocument(input: OfficeInput): OfficeDocument {
  if (input.format !== "docx" && input.format !== "odt")
    throw new Error("Not a rich document");
  return new DocumentReader(input).read();
}

class DocumentReader {
  private readonly pkg;
  private readonly main: string;
  private readonly charts: Chart[] = [];
  private readonly admitChart: ReturnType<typeof chartAdmission>;
  private readonly noteBodies = new Map<string, NoteBodies>();
  private readonly noteParts = new Map<
    "footnote" | "endnote",
    string | undefined
  >();
  private readonly styles = new Map<string, WordStyle>();
  private readonly odfPatches = new WeakMap<Element, RunStyle>();
  private readonly styleLevels = new WeakMap<Element, Map<number, Element>>();
  private readonly odfRuns = new Map<string, RunStyle>();
  private readonly listDefinitions = new Map<
    string,
    { tag: "ul" | "ol"; start: number } | undefined
  >();
  private readonly odfListDefinitions = new Map<
    string,
    Map<number, { numbered: boolean; start: number; key: string }>
  >();
  private readonly resourceTargets = new WeakMap<
    Element,
    { href: string; path?: string | undefined }
  >();
  private readonly httpsTargets = new Map<string, boolean>();
  private readonly citations = new WeakMap<Element, string>();
  private readonly odfObjects = new Map<string, OdfObject>();
  private readonly odfCommonStyles = new Map<string, Element>();
  private readonly odfAutomaticStyles = new Map<string, Element>();
  private readonly odfListStyles = new Map<string, Element>();
  private readonly fonts = new Map<string, boolean>();
  private readonly notes = new Map<string, Note>();
  private readonly noteQueue: Note[] = [];
  private nextNote = 0;
  private hiddenContent = 0;
  private admissionDepth = 0;
  private truncated = false;
  private counters = new Map<string, number>();
  private odfListEnds = new Map<string, number>();
  private defaultRun: RunStyle = {};
  private defaultParagraph: Element | undefined;
  private defaultParagraphStyle?: string;
  private accents?: string[];
  private readonly numbers = new Map<string, Element>();
  private readonly abstractNumbers = new Map<string, Element>();
  private readonly relationshipsByPart = new Map<
    string,
    ReadonlyMap<string, Relationship>
  >();
  private readonly pictureMetadata = new WeakMap<
    Element,
    { alt?: string | undefined; width: number; height: number }
  >();
  private budget = 0;

  constructor(private readonly input: OfficeInput) {
    this.pkg = input.package;
    this.admitChart = chartAdmission(() => this.pkg.check());
    this.main =
      input.main ??
      (input.format === "docx" ? "word/document.xml" : "content.xml");
  }

  private guard(depth: number, count = 1): void {
    this.pkg.check();
    if (depth > MAX_RENDER_DEPTH)
      throw new OfficeFailure("too-large", "Rich document nesting limit");
    this.budget += count;
    if (this.budget > MAX_RENDER_CHARS) throw new RenderLimit();
  }

  /** Active -> truncated is terminal. Nested blocks bubble overflow to the
   * outer admission, so a table/list/paragraph is never returned half built. */
  private admit<T>(build: () => T): T | undefined {
    if (this.truncated) return undefined;
    const outer = this.admissionDepth++ === 0,
      charts = this.charts.length,
      notes = this.noteQueue.length;
    const media = this.pkg.media.size;
    try {
      const result = build();
      if (outer) this.readPendingNotes();
      return result;
    } catch (error) {
      if (!(error instanceof RenderLimit) || !outer) throw error;
      this.truncated = true;
      this.charts.length = charts;
      // New references from the rejected block must not leave orphan notes or
      // charts or picture Blobs. Media is append-only during document reading;
      // scan once on terminal truncation instead of copying it for every block.
      // No later block can reuse the package's rejected picture-cache entries.
      let retained = 0;
      for (const ref of this.pkg.media.keys())
        if (retained++ >= media) this.pkg.media.delete(ref);
      // Previously admitted references already have complete bodies.
      for (let i = notes; i < this.noteQueue.length; i++)
        this.notes.delete(required(this.noteQueue[i]).key);
      this.noteQueue.length = notes;
      this.nextNote = notes;
      return undefined;
    } finally {
      this.admissionDepth--;
    }
  }

  private readPendingNotes(): void {
    if (this.nextNote >= this.noteQueue.length) return;
    // Reserve note bodies with their first referring block. Keep note list
    // counters separate so this eager reservation cannot renumber body lists.
    const counters = this.counters,
      ends = this.odfListEnds;
    this.guard(0, counters.size + ends.size);
    this.counters = new Map(counters);
    this.odfListEnds = new Map(ends);
    try {
      while (this.nextNote < this.noteQueue.length) {
        const note = required(this.noteQueue[this.nextNote++]);
        note.content = note.body
          ? this.input.format === "docx"
            ? this.wordBlocks(note.body, note.part, 1)
            : this.odfBlocks(note.body, note.part, 1)
          : [];
      }
    } finally {
      this.counters = counters;
      this.odfListEnds = ends;
    }
  }

  private related(
    part: string,
    suffix: string,
    fallback?: string,
  ): string | undefined {
    const rel = [...this.relationships(part).values()].find(
      (value) => !value.external && value.type.endsWith(`/${suffix}`),
    );
    return rel?.target ?? fallback;
  }

  private relationships(part: string): ReadonlyMap<string, Relationship> {
    let cached = this.relationshipsByPart.get(part);
    if (!cached) {
      cached = this.pkg.relationships(part);
      this.relationshipsByPart.set(part, cached);
    }
    return cached;
  }

  read(): OfficeDocument {
    this.guard(0);
    const doc = this.pkg.xml(this.main);
    if (!doc) throw new Error("Missing rich document part");
    let nodes: Node[];
    if (this.input.format === "docx") {
      const styles = this.pkg.xml(
        required(
          this.related(this.main, "styles", partPath(this.main, "styles.xml")),
        ),
      );
      if (styles) {
        this.defaultRun = wordRunStyle(
          child(
            child(descendants(styles, "docDefaults")[0], "rPrDefault"),
            "rPr",
          ),
        );
        this.defaultParagraph = child(
          child(descendants(styles, "docDefaults")[0], "pPrDefault"),
          "pPr",
        );
        for (const style of descendants(styles, "style")) {
          const id = attr(style, "styleId");
          if (id)
            this.styles.set(id, {
              heading: headingByName(attr(child(style, "name"), "val") ?? id),
              basedOn: attr(child(style, "basedOn"), "val"),
              p: child(style, "pPr"),
              r: wordRunStyle(child(style, "rPr")),
            });
          if (
            id &&
            attr(style, "type") === "paragraph" &&
            /^(?:1|true|on)$/i.test(attr(style, "default") ?? "")
          )
            this.defaultParagraphStyle = id;
        }
      }
      const numbering = this.pkg.xml(
        required(
          this.related(
            this.main,
            "numbering",
            partPath(this.main, "numbering.xml"),
          ),
        ),
      );
      if (numbering) {
        for (const num of descendants(numbering, "num"))
          this.numbers.set(attr(num, "numId") ?? "", num);
        for (const num of descendants(numbering, "abstractNum"))
          this.abstractNumbers.set(attr(num, "abstractNumId") ?? "", num);
      }
      const themePath = this.related(this.main, "theme"),
        theme = themePath ? this.pkg.xml(themePath) : undefined;
      const scheme = theme && descendants(theme, "clrScheme")[0];
      if (scheme)
        this.accents = [1, 2, 3, 4, 5, 6].map((index) => {
          const accent = child(scheme, `accent${index}`),
            color = child(accent, "srgbClr") ?? child(accent, "sysClr");
          return `#${attr(color, "lastClr") ?? attr(color, "val") ?? ""}`;
        });
      const body = child(doc.documentElement, "body");
      if (!body) throw new Error("Missing Word body");
      nodes = this.wordBlocks(body, this.main, 0);
    } else {
      for (const styles of [this.pkg.xml("styles.xml"), doc])
        if (styles) {
          for (const font of descendants(styles, "font-face"))
            this.fonts.set(
              attr(font, "name") ?? "",
              monospace(attr(font, "font-family") ?? ""),
            );
          // Common parents belong to office:styles. Automatic styles apply
          // only to their own part, so styles.xml's automatics cannot style body text.
          for (const [scope, target] of [
            [child(styles.documentElement, "styles"), this.odfCommonStyles],
            [
              styles === doc
                ? child(styles.documentElement, "automatic-styles")
                : undefined,
              this.odfAutomaticStyles,
            ],
          ] as const)
            if (scope) {
              for (const style of children(scope, "style")) {
                const name = attr(style, "name"),
                  family = attr(style, "family");
                if (name && family) target.set(`${family}\0${name}`, style);
              }
            }
          for (const style of descendants(styles, "list-style")) {
            const name = attr(style, "name");
            if (name) this.odfListStyles.set(name, style);
          }
          for (const style of descendants(styles, "default-style"))
            if (attr(style, "family") === "paragraph")
              this.defaultRun = odfRunStyle(
                child(style, "text-properties"),
                this.defaultRun,
                this.fonts,
              );
        }
      const body = child(child(doc.documentElement, "body"), "text");
      if (!body) throw new Error("Missing ODF text body");
      nodes = this.odfBlocks(body, this.main, 0);
    }
    if (this.notes.size) {
      const list = element("ol");
      for (const note of this.notes.values())
        list.children.push(element("li", note.content ?? [], { id: note.id }));
      nodes.push(element("section", [list], { className: ["footnotes"] }));
    }
    const tree: Root = { type: "root", children: nodes };
    return {
      family: "document",
      charts: this.charts,
      parsed: parseOfficeTree(tree),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  private styleChain(id: string | undefined): WordStyle[] {
    const chain: WordStyle[] = [],
      seen = new Set<string>();
    while (id && !seen.has(id) && chain.length < MAX_RENDER_DEPTH) {
      seen.add(id);
      const style = this.styles.get(id);
      if (!style) break;
      chain.unshift(style);
      id = style.basedOn;
    }
    return chain;
  }

  private styleLevel(
    node: Element | undefined,
    level: number,
    tag?: string,
  ): Element | undefined {
    if (!node) return undefined;
    let saved = this.styleLevels.get(node);
    if (!saved) {
      saved = new Map();
      for (const entry of Array.from(node.children)) {
        if (tag && entry.localName !== tag) continue;
        const index = integer(attr(entry, tag ? "ilvl" : "level"), tag ? 0 : 1);
        if (!saved.has(index)) saved.set(index, entry);
      }
      this.styleLevels.set(node, saved);
    }
    return saved.get(level);
  }

  private wordParagraph(
    node: Element,
    part: string,
    depth: number,
    fields: Fields,
  ): { nodes: Node[]; list?: ListSpec | undefined } {
    const p = child(node, "pPr"),
      id = attr(child(p, "pStyle"), "val") ?? this.defaultParagraphStyle,
      chain = this.styleChain(id);
    const properties = [
      this.defaultParagraph,
      ...chain.map((style) => style.p),
      p,
    ];
    const property = (name: string) =>
      properties
        .map((pr) => child(pr, name))
        .filter((pr): pr is Element => !!pr)
        .at(-1);
    let runStyle = this.defaultRun;
    for (const style of chain) runStyle = wordStyle(runStyle, style.r);
    const outline = attr(property("outlineLvl"), "val"),
      lastStyle = chain.at(-1);
    const heading =
      outline !== undefined
        ? /^[0-5]$/.test(outline)
          ? Number(outline) + 1
          : undefined
        : lastStyle
          ? lastStyle.heading
          : headingByName(id ?? "");
    const tag = heading ? `h${heading}` : "p";
    const result: Node[] = [];
    let inlines: Node[] = [];
    const flush = () => {
      if (inlines.length) {
        result.push(element(tag, inlines));
        inlines = [];
      }
    };
    const hiddenBefore = this.hiddenContent,
      values = this.wordInline(node, part, runStyle, fields, depth + 1);
    if (this.hiddenContent !== hiddenBefore && !hasVisibleContent(values))
      return { nodes: [] };
    for (const item of values) {
      if (item.type === "pageBreak") flush();
      else if (isBlock(item)) {
        flush();
        result.push(item);
      } else inlines.push(item);
    }
    flush();
    if (!result.length) result.push(element(tag));
    const nums = properties.map((pr) => child(pr, "numPr"));
    const numberProperty = (name: string) =>
      nums
        .map((num) => child(num, name))
        .filter((value): value is Element => !!value)
        .at(-1);
    const numId = attr(numberProperty("numId"), "val"),
      level = integer(attr(numberProperty("ilvl"), "val"), 0);
    return {
      nodes: result,
      ...(numId && numId !== "0"
        ? { list: this.wordList(numId, Math.min(level, 8)) }
        : {}),
    };
  }

  private wordList(id: string, level: number): ListSpec | undefined {
    const key = `${id}:${level}`;
    if (!this.listDefinitions.has(key)) {
      const num = this.numbers.get(id);
      const abstract = this.abstractNumbers.get(
        attr(child(num, "abstractNumId"), "val") ?? "",
      );
      const override = this.styleLevel(num, level, "lvlOverride");
      const definition =
        child(override, "lvl") ?? this.styleLevel(abstract, level, "lvl");
      this.listDefinitions.set(
        key,
        definition
          ? {
              tag:
                attr(child(definition, "numFmt"), "val") === "bullet"
                  ? "ul"
                  : "ol",
              start: integer(
                attr(
                  child(override, "startOverride") ??
                    child(definition, "start"),
                  "val",
                ),
              ),
            }
          : undefined,
      );
    }
    const definition = this.listDefinitions.get(key);
    if (!definition) return undefined;
    const start = this.counters.get(key) ?? definition.start;
    this.counters.set(key, start + 1);
    for (let deeper = level + 1; deeper <= 8; deeper++)
      this.counters.delete(`${id}:${deeper}`);
    return { key: id, level, tag: definition.tag, start };
  }

  private wordBlocks(
    parent: Element,
    part: string,
    depth: number,
    fields: Fields = { stack: [], instructions: 0 },
  ): Node[] {
    this.admit(() => this.guard(depth));
    const out: Node[] = [],
      stack: { spec: ListSpec; list: HastElement; item?: HastElement }[] = [];
    for (const node of Array.from(parent.children)) {
      if (this.truncated) break;
      this.admit(() => this.guard(depth));
      if (this.truncated) break;
      if (node.localName === "p") {
        const paragraph = this.admit(() =>
          this.wordParagraph(node, part, depth + 1, fields),
        );
        if (!paragraph) break;
        if (!paragraph.nodes.length) continue;
        const spec = paragraph.list;
        if (!spec) {
          stack.length = 0;
          append(out, paragraph.nodes);
          continue;
        }
        while (
          stack.length &&
          (required(stack.at(-1)).spec.level > spec.level ||
            required(stack.at(-1)).spec.key !== spec.key ||
            (required(stack.at(-1)).spec.level === spec.level &&
              required(stack.at(-1)).spec.tag !== spec.tag))
        )
          stack.pop();
        let frame = stack.at(-1);
        if (!frame || frame.spec.level !== spec.level) {
          const list = element(
            spec.tag,
            [],
            spec.tag === "ol" ? { start: spec.start } : {},
          );
          if (frame?.item) frame.item.children.push(list);
          else out.push(list);
          frame = { spec, list };
          stack.push(frame);
        }
        frame.item = element("li", paragraph.nodes);
        frame.list.children.push(frame.item);
      } else if (node.localName === "tbl") {
        const table = this.admit(() =>
          this.wordTable(node, part, depth + 1, fields),
        );
        if (!table) break;
        stack.length = 0;
        out.push(table);
      } else if (wordContainers.has(node.localName)) {
        stack.length = 0;
        append(out, this.wordBlocks(node, part, depth + 1, fields));
      }
    }
    return out;
  }

  /** Traverse structural wrappers only: descendant searches would also pick
   * up rows and cells belonging to a nested table or a deleted revision. */
  private *wordTableParts(
    parent: Element,
    name: "tr" | "tc",
    depth: number,
  ): Generator<{ node: Element; depth: number }> {
    for (const node of Array.from(parent.children)) {
      if (node.localName === name) yield { node, depth };
      else if (wordContainers.has(node.localName)) {
        this.guard(depth);
        yield* this.wordTableParts(node, name, depth + 1);
      }
    }
  }

  private wordTable(
    table: Element,
    part: string,
    depth: number,
    fields: Fields,
  ): HastElement {
    this.guard(depth);
    const rows: Node[] = [];
    let active = new Map<number, HastElement>();
    for (const { node: row, depth: rowDepth } of this.wordTableParts(
      table,
      "tr",
      depth,
    )) {
      const next = new Map<number, HastElement>(),
        cells: Node[] = [],
        advanced = new Set<HastElement>();
      const before = integer(
        attr(child(child(row, "trPr"), "gridBefore"), "val"),
        0,
      );
      this.guard(rowDepth, before);
      let column = before;
      const header = enabled(child(child(row, "trPr"), "tblHeader"));
      for (const { node: cell, depth: cellDepth } of this.wordTableParts(
        row,
        "tc",
        rowDepth,
      )) {
        this.guard(cellDepth);
        const pr = child(cell, "tcPr"),
          span = Math.max(1, integer(attr(child(pr, "gridSpan"), "val"))),
          merge = child(pr, "vMerge");
        // Reserve every expanded merge column before either map-building loop.
        if (merge) this.guard(cellDepth, span);
        const previous = active.get(column);
        if (merge && attr(merge, "val") !== "restart" && previous) {
          if (!advanced.has(previous)) {
            previous.properties.rowSpan =
              Number(previous.properties.rowSpan ?? 1) + 1;
            advanced.add(previous);
          }
          for (let i = 0; i < span; i++) next.set(column + i, previous);
        } else {
          const content = this.wordBlocks(cell, part, cellDepth + 1, fields),
            rendered = element(header ? "th" : "td", content, {
              ...(span > 1 ? { colSpan: span } : {}),
              ...(header ? { scope: "col" } : {}),
            });
          cells.push(rendered);
          if (merge)
            for (let i = 0; i < span; i++) next.set(column + i, rendered);
        }
        column += span;
      }
      // A continued rowspan can already cover part of the omitted prefix.
      const gaps: Node[] = [];
      for (let i = 0; i < before; i++) {
        const previous = active.get(i);
        if (previous === undefined || !advanced.has(previous))
          gaps.push(element("td"));
      }
      active = next;
      rows.push(element("tr", gaps.concat(cells)));
    }
    return element("table", [element("tbody", rows)]);
  }

  private fieldHref(instruction: string): string | undefined {
    const match = /^\s*HYPERLINK\s+([\s\S]*)/i.exec(instruction);
    if (!match) return undefined;
    const local = /(?:^|\s)\\l\s+(?:"([^"]*)"|([^\\\s"]+))/i.exec(
      required(match[1]),
    );
    // The address and local switch can occur in either order. A switch is
    // never the address; an omitted/empty address keeps a local-only link.
    const address = local
      ? required(match[1]).replace(local[0], " ")
      : required(match[1]);
    const target = /^\s*(?:"([^"]*)"|([^\\\s"]\S*))/.exec(address);
    const url = target?.[1] ?? target?.[2],
      bookmark = local?.[1] ?? local?.[2];
    return bookmark ? `${url ?? ""}#${bookmark}` : url;
  }

  private wordInline(
    parent: Element,
    part: string,
    style: RunStyle,
    fields: Fields,
    depth: number,
    hiddenRun = false,
  ): Inline[] {
    this.guard(depth);
    const out: Inline[] = [];
    for (const node of Array.from(parent.children)) {
      this.guard(depth);
      const name = node.localName;
      if (
        [
          "pPr",
          "rPr",
          "del",
          "moveFrom",
          "instrText",
          "delText",
          "object",
          "altChunk",
          "commentReference",
        ].includes(name)
      ) {
        const field = fields.stack.at(-1);
        if (name === "instrText" && field?.phase === "instruction") {
          const instruction = node.textContent ?? "";
          this.guard(depth, instruction.length);
          field.instruction += instruction;
        }
        continue;
      }
      if (name === "fldChar") {
        const type = attr(node, "fldCharType");
        if (type === "begin") {
          fields.stack.push({ phase: "instruction", instruction: "" });
          fields.instructions++;
        } else if (
          type === "separate" &&
          fields.stack.at(-1)?.phase === "instruction"
        ) {
          const field = required(fields.stack.at(-1));
          if (field.phase === "instruction") {
            fields.stack[fields.stack.length - 1] = {
              phase: "result",
              href: this.fieldHref(field.instruction),
            };
            fields.instructions--;
          }
        } else if (
          type === "end" &&
          fields.stack.pop()?.phase === "instruction"
        )
          fields.instructions--;
        continue;
      }
      // Field controls in a hidden run still delimit later visible results.
      if (hiddenRun) {
        if (
          node.textContent ||
          node.children.length ||
          [
            "tab",
            "br",
            "cr",
            "noBreakHyphen",
            "softHyphen",
            "footnoteReference",
            "endnoteReference",
          ].includes(name)
        )
          this.hiddenContent++;
        continue;
      }
      if (name === "r") {
        const pr = child(node, "rPr");
        let inherited = style;
        for (const item of this.styleChain(attr(child(pr, "rStyle"), "val")))
          inherited = wordStyle(inherited, item.r);
        const run = wordRunStyle(pr, inherited);
        append(
          out,
          styled(
            this.wordInline(node, part, {}, fields, depth + 1, run.hidden),
            run,
          ),
        );
        continue;
      }
      if (fields.instructions > 0) {
        // Still traverse containers, so a separate/end marker can leave instruction state.
        if (node.children.length)
          append(out, this.wordInline(node, part, style, fields, depth + 1));
        continue;
      }
      let nodes: Inline[] = [];
      if (name === "t") {
        const value = node.textContent ?? "";
        this.guard(depth, value.length);
        nodes = [text(value)];
      } else if (name === "tab") nodes = [text("\t")];
      else if (name === "br" || name === "cr")
        nodes =
          attr(node, "type") === "page"
            ? [{ type: "pageBreak" }]
            : [element("br")];
      else if (name === "noBreakHyphen") nodes = [text("‑")];
      else if (name === "softHyphen") nodes = [text("\u00ad")];
      else if (name === "bookmarkStart") {
        const id = attr(node, "name");
        if (id && id !== "_GoBack") nodes = [element("span", [], { id })];
      } else if (name === "hyperlink" || name === "fldSimple") {
        const rel = this.relationships(part).get(attr(node, "id") ?? "");
        const anchor = attr(node, "anchor"),
          instruction = name === "fldSimple" ? (attr(node, "instr") ?? "") : "";
        if (name === "fldSimple") this.guard(depth, instruction.length);
        const href =
          name === "fldSimple"
            ? this.fieldHref(instruction)
            : rel?.external
              ? rel.target
              : anchor
                ? `#${anchor}`
                : undefined;
        const hiddenBefore = this.hiddenContent;
        const content = this.wordInline(
          node,
          part,
          style,
          fields,
          depth + 1,
        ).filter((value): value is Node => value.type !== "pageBreak");
        if (
          (style.hidden || this.hiddenContent !== hiddenBefore) &&
          !hasVisibleContent(content)
        )
          continue;
        if (href) this.guard(depth, href.length);
        nodes = href ? [element("a", content, { href })] : content;
      } else if (name === "footnoteReference" || name === "endnoteReference")
        nodes = [
          this.wordNote(
            node,
            name === "footnoteReference" ? "footnote" : "endnote",
          ),
        ];
      else if (name === "txbxContent")
        nodes = this.wordBlocks(node, part, depth + 1);
      else if (name === "oMath" || name === "oMathPara")
        nodes = [element("code", [text(this.mathText(node, depth + 1))])];
      else if (name === "blip" || name === "imagedata")
        nodes = [this.wordPicture(node, part, depth)];
      else if (name === "chart") {
        const chart = this.wordChart(node, part);
        if (chart) nodes = [chart];
      } else if (name === "AlternateContent") {
        // Render one representation. Unsupported EMF/WMF choices can carry a PNG fallback.
        const choice =
          children(node, "Choice").find((candidate) => {
            const images = [
              ...descendants(candidate, "blip"),
              ...descendants(candidate, "imagedata"),
            ];
            return images.length
              ? images.every((image) => {
                  const rel = this.relationships(part).get(
                    attr(image, "embed") ??
                      attr(image, "link") ??
                      attr(image, "id") ??
                      "",
                  );
                  // Choose without allocating media from a representation we may discard.
                  return (
                    rel &&
                    (rel.external
                      ? this.isHttps(rel.target)
                      : this.pkg.parts.has(rel.target) &&
                        !/\.(?:emf|wmf|svg|tiff?)$/i.test(rel.target))
                  );
                })
              : descendants(candidate, "chart").length > 0 ||
                  descendants(candidate, "txbxContent").length > 0;
          }) ??
          child(node, "Fallback") ??
          child(node, "Choice");
        if (choice)
          nodes = this.wordInline(choice, part, style, fields, depth + 1);
      } else nodes = this.wordInline(node, part, style, fields, depth + 1);
      const field = fields.stack.at(-1),
        href =
          field?.phase === "result" && !fields.instructions
            ? field.href
            : undefined;
      if (
        href &&
        ["t", "tab", "br", "cr", "noBreakHyphen", "softHyphen"].includes(
          name,
        ) &&
        nodes.length &&
        nodes.every((item) => item.type !== "pageBreak")
      ) {
        this.guard(depth, href.length);
        nodes = [element("a", nodes as Node[], { href })];
      }
      append(out, nodes);
    }
    return out;
  }

  private mathText(
    node: Element,
    depth: number,
    measure?: { depth: number },
  ): string {
    this.guard(depth);
    if (measure) measure.depth = Math.max(measure.depth, depth);
    if (["t", "mi", "mo", "mn", "mtext"].includes(node.localName)) {
      const value = node.textContent ?? "";
      this.guard(depth, value.length);
      return value;
    }
    const content = (name: string) => {
      const value = child(node, name);
      return value ? this.mathText(value, depth + 1, measure) : "";
    };
    if (node.localName === "f")
      return `(${content("num")})/(${content("den")})`;
    if (node.localName === "sSup" || node.localName === "sSub")
      return `${content("e")}${node.localName === "sSup" ? "^" : "_"}(${content(node.localName === "sSup" ? "sup" : "sub")})`;
    if (
      node.localName === "mfrac" ||
      node.localName === "msup" ||
      node.localName === "msub"
    ) {
      const values = Array.from(node.children).map((value) =>
        this.mathText(value, depth + 1, measure),
      );
      return node.localName === "mfrac"
        ? `(${values[0] ?? ""})/(${values[1] ?? ""})`
        : `${values[0] ?? ""}${node.localName === "msup" ? "^" : "_"}(${values[1] ?? ""})`;
    }
    return Array.from(node.children)
      .filter((value) => !value.localName.endsWith("Pr"))
      .map((value) => this.mathText(value, depth + 1, measure))
      .join("");
  }

  private wordNote(mark: Element, kind: "footnote" | "endnote"): HastElement {
    const key = `${kind}:${attr(mark, "id") ?? ""}`;
    let note = this.notes.get(key);
    if (!note) {
      // Resolve once per kind, including a missing relationship/part. Keep
      // the first matching relationship and the existing fallback semantics.
      if (!this.noteParts.has(kind))
        this.noteParts.set(
          kind,
          this.related(
            this.main,
            `${kind}s`,
            partPath(this.main, `${kind}s.xml`),
          ),
        );
      const path = required(this.noteParts.get(kind));
      let bodies = this.noteBodies.get(path);
      if (!bodies) {
        bodies = { footnote: new Map(), endnote: new Map() };
        const doc = this.pkg.xml(path);
        if (doc) {
          const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            this.guard(0);
            const body = node as Element,
              name = body.localName;
            if (name !== "footnote" && name !== "endnote") continue;
            const id = attr(body, "id");
            if (!bodies[name].has(id)) bodies[name].set(id, body);
          }
        }
        this.noteBodies.set(path, bodies);
      }
      note = {
        key,
        number: this.notes.size + 1,
        id: `mdv-${kind}-${this.notes.size + 1}`,
        part: path,
        body: bodies[kind].get(attr(mark, "id")),
      };
      this.notes.set(key, note);
      this.noteQueue.push(note);
    }
    return element("sup", [
      element("a", [text(String(note.number))], {
        href: `#${note.id}`,
        dataFootnoteRef: true,
      }),
    ]);
  }

  private wordPicture(blip: Element, part: string, depth: number): HastElement {
    const rel = this.relationships(part).get(
      attr(blip, "embed") ?? attr(blip, "link") ?? attr(blip, "id") ?? "",
    );
    let container: Element = blip;
    while (
      container.parentElement &&
      !["drawing", "pict"].includes(container.localName)
    )
      container = container.parentElement;
    let metadata = this.pictureMetadata.get(container);
    if (!metadata) {
      const description =
          descendants(container, "docPr")[0] ??
          descendants(container, "cNvPr")[0],
        extent = descendants(container, "extent")[0];
      metadata = {
        alt: attr(description, "descr") ?? attr(description, "title"),
        width: Number(attr(extent, "cx")) / 9525,
        height: Number(attr(extent, "cy")) / 9525,
      };
      this.pictureMetadata.set(container, metadata);
    }
    const { width, height } = metadata,
      alt = metadata.alt ?? attr(blip, "title") ?? "Picture";
    this.guard(depth, alt.length);
    const src = rel
      ? rel.external
        ? this.isHttps(rel.target)
          ? rel.target
          : undefined
        : (this.pkg.picture(rel.target) ?? undefined)
      : undefined;
    this.guard(depth, rel?.external && src ? src.length : 0);
    return element("img", [], {
      alt,
      ...(src ? { src } : {}),
      ...(width > 0 && width <= 9999 ? { width: Math.round(width) } : {}),
      ...(height > 0 && height <= 9999 ? { height: Math.round(height) } : {}),
    });
  }

  private wordChart(node: Element, part: string): HastElement | undefined {
    const rel = this.relationships(part).get(attr(node, "id") ?? "");
    if (!rel || rel.external) return undefined;
    const doc = this.pkg.xml(rel.target);
    if (!doc) return undefined;
    const chart = this.admitChart(doc, () => readChart(doc, this.accents));
    if (!chart) throw new RenderLimit();
    const index = this.charts.length;
    this.charts.push(chart);
    return element("figure", [], { dataMdvChart: index });
  }

  private odfStyle(
    name: string | undefined,
    family: "paragraph" | "text",
    inherited: RunStyle = this.defaultRun,
  ): RunStyle {
    const key = `${family}\0${name ?? ""}`;
    let patch = this.odfRuns.get(key);
    if (!patch) {
      const chain: Element[] = [],
        seen = new Set<Element>();
      let style =
        this.odfAutomaticStyles.get(key) ?? this.odfCommonStyles.get(key);
      while (style && !seen.has(style) && chain.length < MAX_RENDER_DEPTH) {
        seen.add(style);
        chain.unshift(style);
        const parent = attr(style, "parent-style-name");
        style = parent
          ? this.odfCommonStyles.get(`${family}\0${parent}`)
          : undefined;
      }
      patch = {};
      for (const style of chain) {
        let own = this.odfPatches.get(style);
        if (!own) {
          own = odfRunStyle(child(style, "text-properties"), {}, this.fonts);
          this.odfPatches.set(style, own);
        }
        patch = { ...patch, ...own };
      }
      this.odfRuns.set(key, patch);
    }
    return { ...inherited, ...patch };
  }

  private odfBlocks(
    parent: Element,
    part: string,
    depth: number,
    selected?: readonly Element[],
  ): Node[] {
    this.admit(() => this.guard(depth));
    const out: Node[] = [];
    for (const node of selected ?? Array.from(parent.children)) {
      if (this.truncated) break;
      this.admit(() => this.guard(depth));
      if (this.truncated) break;
      if (
        ["section", "text-box", "list-item", "note-body"].includes(
          node.localName,
        )
      ) {
        append(out, this.odfBlocks(node, part, depth + 1));
        continue;
      }
      const blocks = this.admit(() => {
        const blocks: Node[] = [];
        if (node.localName === "p" || node.localName === "h") {
          const level = Math.max(
            1,
            Math.min(6, integer(attr(node, "outline-level"))),
          );
          const hiddenBefore = this.hiddenContent,
            values = this.odfInline(
              node,
              part,
              this.odfStyle(attr(node, "style-name"), "paragraph"),
              depth + 1,
            );
          if (this.hiddenContent !== hiddenBefore && !hasVisibleContent(values))
            return blocks;
          let inlines: Node[] = [];
          const flush = () => {
            if (inlines.length) {
              blocks.push(
                element(node.localName === "h" ? `h${level}` : "p", inlines),
              );
              inlines = [];
            }
          };
          for (const item of values) {
            if (item.type === "pageBreak") flush();
            else if (isBlock(item)) {
              flush();
              blocks.push(item);
            } else inlines.push(item);
          }
          flush();
          if (!values.length)
            blocks.push(element(node.localName === "h" ? `h${level}` : "p"));
        } else if (node.localName === "list")
          append(blocks, this.odfList(node, part, depth + 1, 1));
        else if (node.localName === "table")
          blocks.push(this.odfTable(node, part, depth + 1));
        else if (node.localName === "frame")
          append(
            blocks,
            this.odfInline(node, part, this.defaultRun, depth + 1).filter(
              (value): value is Node => value.type !== "pageBreak",
            ),
          );
        return blocks;
      });
      if (!blocks) break;
      append(out, blocks);
    }
    return out;
  }

  private odfList(
    node: Element,
    part: string,
    depth: number,
    level: number,
    inheritedName?: string,
  ): Node[] {
    this.guard(depth);
    const listHiddenBefore = this.hiddenContent;
    const name = attr(node, "style-name") ?? inheritedName ?? "";
    let definitions = this.odfListDefinitions.get(name);
    if (!definitions) {
      definitions = new Map();
      this.odfListDefinitions.set(name, definitions);
    }
    let definition = definitions.get(level);
    if (!definition) {
      const style = this.styleLevel(this.odfListStyles.get(name), level);
      definition = {
        numbered: style?.localName === "list-level-style-number",
        start: integer(attr(style, "start-value")),
        key: `${name}:${level}`,
      };
      definitions.set(level, definition);
    }
    const { numbered, key } = definition,
      items = children(node, "list-item");
    const continuation =
      attr(node, "continue-list") ??
      (attr(node, "continue-numbering") === "true" ? key : undefined);
    const start =
      nonnegativeInteger(attr(items[0], "start-value")) ??
      (continuation
        ? (this.odfListEnds.get(continuation) ?? 1)
        : definition.start);
    const out: Node[] = [];
    let list: HastElement | undefined,
      counter = start;
    for (const item of Array.from(node.children)) {
      if (item.localName !== "list-item" && item.localName !== "list-header")
        continue;
      this.guard(depth);
      // Headers have the same block content as items, including nested lists
      // that inherit this list's style and advance to the next nesting level.
      const hiddenBefore = this.hiddenContent,
        content: Node[] = [];
      for (const block of Array.from(item.children)) {
        if (block.localName === "list")
          append(
            content,
            this.odfList(block, part, depth + 1, level + 1, name),
          );
        else append(content, this.odfBlocks(item, part, depth + 1, [block]));
      }
      if (item.localName === "list-header") {
        append(out, content);
        list = undefined;
        continue;
      }
      if (this.hiddenContent !== hiddenBefore && !hasVisibleContent(content))
        continue;
      const restart = numbered
        ? nonnegativeInteger(attr(item, "start-value"))
        : undefined;
      if (restart !== undefined) counter = restart;
      if (!list) {
        list = element(
          numbered ? "ol" : "ul",
          [],
          numbered ? { start: counter } : {},
        );
        out.push(list);
      }
      list.children.push(
        element(
          "li",
          content,
          restart !== undefined ? { ["value" as string]: restart } : {},
        ),
      );
      // This list owns its counter; recursive nested lists cannot change it.
      counter = Math.min(counter + 1, Number.MAX_SAFE_INTEGER);
    }
    this.odfListEnds.set(key, counter);
    const id = attr(node, "id");
    if (id) this.odfListEnds.set(id, counter);
    // An empty ordinary list retains its representation. A header is a
    // sibling block, so it never acquires an item marker or increments it.
    return out.length || this.hiddenContent !== listHiddenBefore
      ? out
      : [element(numbered ? "ol" : "ul", [], numbered ? { start } : {})];
  }

  private odfTable(table: Element, part: string, depth: number): HastElement {
    this.guard(depth);
    const rows: Node[] = [];
    const addRows = (parent: Element, header = false, level = depth) => {
      this.guard(level);
      for (const row of Array.from(parent.children)) {
        if (row.localName === "table-row") {
          const repeat = Math.max(
            1,
            integer(attr(row, "number-rows-repeated")),
          );
          for (let r = 0; r < repeat; r++) {
            this.guard(depth);
            const cells: Node[] = [];
            for (const cell of Array.from(row.children))
              if (cell.localName === "table-cell") {
                const count = Math.max(
                  1,
                  integer(attr(cell, "number-columns-repeated")),
                );
                for (let c = 0; c < count; c++) {
                  this.guard(depth);
                  const colSpan = integer(attr(cell, "number-columns-spanned")),
                    rowSpan = integer(attr(cell, "number-rows-spanned"));
                  cells.push(
                    element(
                      header ? "th" : "td",
                      this.odfBlocks(cell, part, depth + 1),
                      {
                        ...(colSpan > 1 ? { colSpan } : {}),
                        ...(rowSpan > 1 ? { rowSpan } : {}),
                        ...(header ? { scope: "col" } : {}),
                      },
                    ),
                  );
                }
              }
            rows.push(element("tr", cells));
          }
        } else if (
          ["table-header-rows", "table-rows", "table-row-group"].includes(
            row.localName,
          )
        )
          addRows(
            row,
            header || row.localName === "table-header-rows",
            level + 1,
          );
      }
    };
    addRows(table);
    return element("table", [element("tbody", rows)]);
  }

  private odfInline(
    parent: Element,
    part: string,
    style: RunStyle,
    depth: number,
  ): Inline[] {
    this.guard(depth);
    const out: Inline[] = [];
    for (const node of Array.from(parent.childNodes)) {
      this.guard(depth);
      if (node.nodeType === 3) {
        if (style.hidden) {
          if (node.textContent) this.hiddenContent++;
          continue;
        }
        const value = node.textContent ?? "";
        this.guard(depth, value.length);
        append(out, styled([text(value)], style));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const item = node as Element,
        name = item.localName;
      if (
        [
          "tracked-changes",
          "deletion",
          "change-start",
          "change-end",
          "change",
          "binary-data",
          "annotation",
          "title",
          "desc",
          "object-ole",
        ].includes(name)
      )
        continue;
      if (style.hidden && name !== "span" && name !== "a") {
        if (
          item.textContent ||
          item.children.length ||
          [
            "s",
            "tab",
            "line-break",
            "soft-page-break",
            "image",
            "object",
            "math",
            "note",
          ].includes(name)
        )
          this.hiddenContent++;
        continue;
      }
      if (name === "s") {
        const count = Math.max(1, integer(attr(item, "c")));
        this.guard(depth, count);
        out.push(text(" ".repeat(count)));
      } else if (name === "tab") out.push(text("\t"));
      else if (name === "line-break") out.push(element("br"));
      else if (name === "soft-page-break") out.push({ type: "pageBreak" });
      else if (
        [
          "bookmark",
          "bookmark-start",
          "reference-mark",
          "reference-mark-start",
        ].includes(name)
      ) {
        const id = attr(item, "name");
        if (id) {
          this.guard(depth, id.length);
          out.push(element("span", [], { id }));
        }
      } else if (name === "a") {
        const linkStyle = this.odfStyle(
            attr(item, "style-name"),
            "text",
            style,
          ),
          hiddenBefore = this.hiddenContent;
        const values = this.odfInline(item, part, linkStyle, depth + 1).filter(
          (value): value is Node => value.type !== "pageBreak",
        );
        if (
          (linkStyle.hidden || this.hiddenContent !== hiddenBefore) &&
          !hasVisibleContent(values)
        )
          continue;
        const href = attr(item, "href") ?? "";
        this.guard(depth, href.length);
        out.push(element("a", values, { href }));
      } else if (name === "note") {
        const key = `odf:${attr(item, "id") ?? this.notes.size}`,
          known = this.notes.get(key);
        const note = known ?? {
          key,
          number: this.notes.size + 1,
          part,
          id: `mdv-note-${this.notes.size + 1}`,
          body: child(item, "note-body"),
        };
        this.notes.set(key, note);
        if (!known) this.noteQueue.push(note);
        const saved =
          this.citations.get(item) ??
          child(item, "note-citation")?.textContent ??
          "";
        this.citations.set(item, saved);
        const citation = saved || String(note.number);
        this.guard(depth, citation.length);
        out.push(
          element("sup", [
            element("a", [text(citation)], {
              href: `#${note.id}`,
              dataFootnoteRef: true,
            }),
          ]),
        );
      } else if (name === "text-box")
        append(out, this.odfBlocks(item, part, depth + 1));
      else if (name === "image") out.push(this.odfPicture(item, part, depth));
      else if (name === "object") {
        const { path } = this.resource(item, part),
          object = path ? this.odfObject(path) : undefined;
        if (object?.kind === "chart") {
          const model = this.admitChart(object.source, () => ({
            type: "unsupported",
            ...(object.title ? { title: object.title } : {}),
          }));
          if (!model) throw new RenderLimit();
          const index = this.charts.length;
          this.charts.push(model);
          out.push(element("figure", [], { dataMdvChart: index }));
        } else if (object?.kind === "math") {
          if (object.rendered)
            this.guard(
              depth + 1 + object.rendered.height,
              object.rendered.cost,
            );
          else {
            const before = this.budget,
              measure = { depth: depth + 1 };
            const value = this.mathText(object.node, depth + 1, measure);
            object.rendered = {
              value,
              cost: this.budget - before,
              height: measure.depth - depth - 1,
            };
          }
          out.push(element("code", [text(object.rendered.value)]));
        }
      } else if (name === "math")
        out.push(element("code", [text(this.mathText(item, depth + 1))]));
      else
        append(
          out,
          this.odfInline(
            item,
            part,
            name === "span"
              ? this.odfStyle(attr(item, "style-name"), "text", style)
              : style,
            depth + 1,
          ),
        );
    }
    return out;
  }

  /** Physical parts have one representation, including absent/unrecognized
   * parts. Keep first matches without allocating all matching descendants. */
  private odfObject(path: string): OdfObject {
    const saved = this.odfObjects.get(path);
    if (saved) return saved;
    const source = this.pkg.xml(path);
    const chart = source?.getElementsByTagNameNS("*", "chart")[0];
    const math = !chart
      ? source?.getElementsByTagNameNS("*", "math")[0]
      : undefined;
    const label = chart
      ? source?.getElementsByTagNameNS("*", "title")[0]?.textContent
      : undefined;
    const result: OdfObject = chart
      ? {
          kind: "chart",
          source: required(source),
          ...(label ? { title: label } : {}),
        }
      : math
        ? { kind: "math", node: math }
        : { kind: "none" };
    this.odfObjects.set(path, result);
    return result;
  }

  private resource(node: Element, part: string) {
    let saved = this.resourceTargets.get(node);
    if (!saved) {
      const href = attr(node, "href") ?? "";
      saved = {
        href,
        path: partPath(
          part,
          node.localName === "object"
            ? `${href.replace(/\/$/, "")}/content.xml`
            : href,
        ),
      };
      this.resourceTargets.set(node, saved);
    }
    return saved;
  }

  private isHttps(value: string): boolean {
    if (!this.httpsTargets.has(value))
      this.httpsTargets.set(value, https(value));
    return required(this.httpsTargets.get(value));
  }

  private odfPicture(image: Element, part: string, depth: number): HastElement {
    const frame = image.parentElement,
      { href, path } = this.resource(image, part);
    const src = this.isHttps(href)
      ? href
      : path
        ? (this.pkg.picture(path) ?? undefined)
        : undefined;
    const size = (value: string | undefined): number | undefined => {
      const match = /^((?:\d+(?:\.\d*)?|\.\d+))(cm|mm|in|pt|pc|px)$/.exec(
        value ?? "",
      );
      if (!match) return undefined;
      const factor: Record<string, number> = {
        cm: 96 / 2.54,
        mm: 96 / 25.4,
        in: 96,
        pt: 96 / 72,
        pc: 16,
        px: 1,
      };
      const n = Math.round(
        Number(match[1]) * required(factor[required(match[2])]),
      );
      return n > 0 && n <= 9999 ? n : undefined;
    };
    let metadata = frame ? this.pictureMetadata.get(frame) : undefined;
    if (!metadata) {
      metadata = {
        width: size(attr(frame ?? undefined, "width")) ?? 0,
        height: size(attr(frame ?? undefined, "height")) ?? 0,
        alt: frame
          ? child(frame, "title")?.textContent ||
            child(frame, "desc")?.textContent ||
            "Picture"
          : "Picture",
      };
      if (frame) this.pictureMetadata.set(frame, metadata);
    }
    const { width, height } = metadata,
      alt = metadata.alt ?? "Picture";
    this.guard(depth, alt.length + (src === href ? href.length : 0));
    return element("img", [], {
      alt,
      ...(src ? { src } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }
}
