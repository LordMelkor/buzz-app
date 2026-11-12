import { required } from "./markdown-limits";
// Shared bounded container/fence recognition; payload is never parsed as owners.
import { MAX_RENDER_DEPTH } from "./markdown-limits";
import { startsBlankHtmlBlock } from "./markdown-html";

export type Owner = Readonly<{
  id: number;
  kind: "quote" | "list";
  marker: string;
  markerOffset: number;
  /** Visual columns on the physical opening line. */
  indent: number;
  content: number;
  /** Width and marker indentation relative to the parent's content column. */
  width: number;
  relativeIndent: number;
  padding: number;
  empty?: boolean | undefined;
  blank?: boolean | undefined;
}>;
export type Fence = Readonly<{
  marker: string;
  size: number;
  opener: string;
  reopen: string;
  close: string;
  continuation: string;
  owners: readonly Owner[];
  indent: number;
}>;
export type FenceState = Readonly<{
  owners: readonly Owner[];
  fence?: Fence | undefined;
  paragraph?: boolean | undefined;
  nextId?: number | undefined;
  overflow?: boolean | undefined;
}>;
export type FenceLine = Readonly<{
  before?: Fence | undefined;
  beforeOwners: readonly Owner[];
  after: FenceState;
  code: boolean;
  opened: boolean;
  endedBefore: boolean;
  body: string;
  bodyOffset: number;
  bodyPadding: number;
}>;

type Position = { at: number; column: number; pending: number };
const space = (char: string | undefined) => char === " " || char === "\t";
const peek = (raw: string, pos: Position) => (pos.pending ? " " : raw[pos.at]);
function advance(raw: string, pos: Position): void {
  if (pos.pending) pos.pending--;
  else {
    if (raw[pos.at] === "\t") pos.pending = 3 - (pos.column % 4);
    pos.at++;
  }
  pos.column++;
}
function whitespace(raw: string, pos: Position, limit: number): number {
  let width = 0;
  while (width < limit && space(peek(raw, pos))) {
    advance(raw, pos);
    width++;
  }
  return width;
}
const bodyAt = (raw: string, pos: Position) =>
  " ".repeat(pos.pending) + raw.slice(pos.at);
const blank = (raw: string, pos: Position) =>
  /^[\t ]*$/.test(raw.slice(pos.at));
const rule = (text: string) =>
  /^(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/.test(text);

/** Positions retain the unconsumed cells of a tab, rather than expanding lines. */
function quote(raw: string, start: Position): Position | undefined {
  const pos = { ...start };
  whitespace(raw, pos, 3);
  if (peek(raw, pos) !== ">") return undefined;
  advance(raw, pos);
  if (space(peek(raw, pos))) advance(raw, pos);
  return pos;
}

function item(
  raw: string,
  start: Position,
  paragraph: boolean,
):
  | {
      pos: Position;
      marker: string;
      markerOffset: number;
      indent: number;
      padding: number;
      empty: boolean;
    }
  | undefined {
  const pos = { ...start };
  whitespace(raw, pos, 3);
  if (pos.pending || rule(raw.slice(pos.at))) return undefined;
  const markerOffset = pos.at,
    indent = pos.column;
  const match = raw.slice(pos.at).match(/^(?:[*+-]|\d{1,9}[.)])(?=[\t ]|$)/);
  if (!match) return undefined;
  const marker = required(match[0]);
  for (let at = 0; at < marker.length; at++) advance(raw, pos);
  const empty = blank(raw, pos);
  if (
    paragraph &&
    (empty || (/^\d/.test(marker) && marker !== "1." && marker !== "1)"))
  )
    return undefined;
  const paddingStart = { ...pos },
    width = whitespace(raw, pos, 5);
  const padding = empty || width > 4 ? 1 : width;
  if (padding !== width) {
    Object.assign(pos, paddingStart);
    whitespace(raw, pos, padding);
  }
  return { pos, marker, markerOffset, indent, padding, empty };
}

function delimiter(
  raw: string,
  start: Position,
):
  | {
      pos: Position;
      marker: string;
      size: number;
      indent: number;
      tail: string;
    }
  | undefined {
  const pos = { ...start },
    indent = whitespace(raw, pos, 3),
    marker = peek(raw, pos);
  if (marker !== "`" && marker !== "~") return undefined;
  let size = 0;
  while (peek(raw, pos) === marker) {
    advance(raw, pos);
    size++;
  }
  return size >= 3
    ? { pos, marker, size, indent, tail: raw.slice(pos.at) }
    : undefined;
}

function interrupts(raw: string, start: Position): boolean {
  const pos = { ...start };
  whitespace(raw, pos, 3);
  const text = bodyAt(raw, pos),
    fence = delimiter(raw, start);
  return (
    blank(raw, start) ||
    /^(?:#{1,6}(?:[\t ]|$)|>|<!--|<\?|<!\[CDATA\[|<![A-Z])/.test(text) ||
    rule(text) ||
    startsBlankHtmlBlock(bodyAt(raw, start)) ||
    !!item(raw, start, true) ||
    (!!fence && (fence.marker !== "`" || !fence.tail.includes("`")))
  );
}

function paragraphAfter(
  raw: string,
  start: Position,
  previous: boolean,
): boolean {
  const pos = { ...start },
    indent = whitespace(raw, pos, 4),
    text = bodyAt(raw, pos);
  if (
    blank(raw, pos) ||
    (indent === 4 && !previous) ||
    /^(?:#{1,6}(?:[\t ]|$))/.test(text) ||
    rule(text)
  )
    return false;
  if (previous && /^(?:=+|-+)[\t ]*$/.test(text)) return false;
  return true;
}

/** Match owners before opening syntax. Concrete code admits no lazy owners and
 * no new containers: marker-looking payload remains literal after its prefix. */
export function fenceLine(
  raw: string,
  state: FenceState,
  opaque = false,
): FenceLine {
  let pos: Position = { at: 0, column: 0, pending: 0 };
  let owners: Owner[] = [],
    nextId =
      state.nextId ??
      state.owners.reduce((next, owner) => Math.max(next, owner.id + 1), 0);
  let paragraph = !!state.paragraph,
    lazy = false,
    overflow = !!state.overflow;
  for (const owner of state.owners) {
    const empty = blank(raw, pos);
    let next = owner.kind === "quote" ? quote(raw, pos) : { ...pos };
    if (owner.kind === "list") {
      if (empty) whitespace(raw, required(next), owner.width);
      else if (
        (owner.empty && owner.blank) ||
        whitespace(raw, required(next), owner.width) !== owner.width
      )
        next = undefined;
    }
    if (!next) {
      const sibling = owner.kind === "list" && !!item(raw, pos, false);
      lazy =
        !state.fence &&
        !opaque &&
        paragraph &&
        !sibling &&
        !interrupts(raw, pos);
      if (lazy) owners = [...state.owners];
      else paragraph = false;
      break;
    }
    pos = next;
    owners.push(
      owner.kind === "list" && owner.empty
        ? { ...owner, blank: empty || undefined, empty }
        : owner,
    );
  }
  if (owners.length < state.owners.length && !lazy) overflow = false;
  const endedBefore =
    !!state.fence && owners.length < state.fence.owners.length;
  const before = endedBefore ? undefined : state.fence;
  const beforeOwners = owners.slice();
  if (before) {
    const fence = delimiter(raw, pos);
    const closed =
      fence &&
      fence.marker === before.marker &&
      fence.size >= before.size &&
      /^[\t ]*$/.test(fence.tail);
    return {
      before,
      beforeOwners,
      code: true,
      opened: false,
      endedBefore,
      body: bodyAt(raw, pos),
      bodyOffset: pos.at,
      bodyPadding: pos.pending,
      after: {
        owners,
        fence: closed ? undefined : before,
        paragraph: false,
        nextId,
      },
    };
  }
  if (!opaque && !lazy && !overflow)
    for (;;) {
      const parent = pos.column,
        quoted = quote(raw, pos),
        listed = quoted ? undefined : item(raw, pos, paragraph);
      if (!quoted && !listed) break;
      if (owners.length >= MAX_RENDER_DEPTH) {
        overflow = true;
        break;
      }
      const markerPos = { ...pos };
      whitespace(raw, markerPos, 3);
      const markerOffset = listed?.markerOffset ?? markerPos.at;
      const indent = listed?.indent ?? markerPos.column;
      pos = quoted ?? required(listed).pos;
      const padding = listed?.padding ?? pos.column - indent - 1;
      const content = listed?.empty
        ? indent + listed.marker.length + padding
        : pos.column;
      owners.push({
        id: nextId++,
        kind: quoted ? "quote" : "list",
        marker: listed?.marker ?? ">",
        markerOffset,
        indent,
        content,
        width: content - parent,
        relativeIndent: indent - parent,
        padding,
        empty: listed?.empty,
      });
      paragraph = false;
    }
  const fence = !opaque && !overflow ? delimiter(raw, pos) : undefined;
  if (fence && (fence.marker !== "`" || !fence.tail.includes("`"))) {
    const opening = owners
      .map(
        (owner) =>
          " ".repeat(owner.relativeIndent) +
          owner.marker +
          " ".repeat(owner.padding),
      )
      .join("");
    const continuation =
      owners
        .map((owner) =>
          owner.kind === "list"
            ? " ".repeat(owner.width)
            : " ".repeat(owner.relativeIndent) +
              ">" +
              " ".repeat(owner.padding),
        )
        .join("") + " ".repeat(fence.indent);
    const afterFence: Fence = {
      marker: fence.marker,
      size: fence.size,
      opener: raw,
      owners: owners.slice(),
      indent: fence.indent,
      reopen:
        opening +
        " ".repeat(fence.indent) +
        fence.marker.repeat(fence.size) +
        fence.tail,
      continuation,
      close: continuation + fence.marker.repeat(fence.size),
    };
    return {
      beforeOwners,
      code: true,
      opened: true,
      endedBefore,
      body: bodyAt(raw, pos),
      bodyOffset: pos.at,
      bodyPadding: pos.pending,
      after: { owners, fence: afterFence, paragraph: false, nextId },
    };
  }
  return {
    beforeOwners,
    code: false,
    opened: false,
    endedBefore,
    body: bodyAt(raw, pos),
    bodyOffset: pos.at,
    bodyPadding: pos.pending,
    after: {
      owners,
      paragraph: !opaque && !overflow && paragraphAfter(raw, pos, paragraph),
      nextId,
      overflow,
    },
  };
}
