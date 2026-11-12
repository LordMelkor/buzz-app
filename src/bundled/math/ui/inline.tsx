// math in message prose. The engine maps the host's text
// segments back to the raw source; this draws each piece.
import type * as ReactNS from "react";
import type {
  DetectOptions,
  Engine,
  MathIndex,
  MathSpan,
  RenderOutcome,
  SegmentPiece,
} from "../contract";
import type { InlineRenderer } from "./host";
import { createDrawing } from "./drawing";
import type { Expand } from "./expand";
import { cachedReferences, type Directory } from "./references";

type Content = Parameters<InlineRenderer["matches"]>[0];
/** A render outcome without its drawing: all a hidden line needs. */
type Result =
  | Readonly<{ ok: true; element?: undefined }>
  | Extract<RenderOutcome, { ok: false }>;

/** How messages are read; the Equation tool checks its insertions with the same rules. */
export const PROSE: DetectOptions = Object.freeze({ singleDollar: true });

/** `directory` reads the host's cached names at each render; the host renders
 * a row again when a name it binds changes, so no subscription is needed. */
export function createInline(
  React: typeof ReactNS,
  engine: Engine,
  Expand: Expand,
  directory: () => Directory | undefined,
): InlineRenderer {
  const Drawing = createDrawing(React);
  const context = cachedReferences(directory);
  // The host asks once per segment, so each message is read once, and again
  // only when its reference context changes.
  const indexes = new WeakMap<
    Content["message"],
    { references: DetectOptions["references"]; index: MathIndex }
  >();
  const read = ({ message }: Content): MathIndex => {
    const references = context(message);
    const hit = indexes.get(message);
    if (hit?.references === references) return hit.index;
    const index = engine.index(message.content, { ...PROSE, references });
    indexes.set(message, { references, index });
    return index;
  };
  // Every delimiter starts with `$` or `\`, so a message
  // without either needs no reference context at all; that answer is kept too.
  const delimited = new WeakMap<Content["message"], boolean>();
  const hasDelimiter = (message: Content["message"]) => {
    let found = delimited.get(message);
    if (found === undefined) {
      found = /[$\\]/.test(message.content);
      delimited.set(message, found);
    }
    return found;
  };
  // A reaction chip's text isn't part of the body the index reads.
  const pieces = (content: Content): readonly SegmentPiece[] =>
    !content.reaction && hasDelimiter(content.message)
      ? read(content).pieces(content.text)
      : [];

  // One call shape, so every piece of a span shares the engine's memo.
  const draw = (span: MathSpan) =>
    engine.render(
      span.tex,
      span.display,
      span.display ? { fleqn: true } : undefined,
    );
  // Each render call clones a drawing, and a hidden line needs only whether
  // its span draws: one answer per span, so a long span holds one drawing.
  const results = new WeakMap<MathSpan, Result>();
  const result = (span: MathSpan): Result => {
    let found = results.get(span);
    if (!found) {
      const outcome = draw(span);
      found = outcome.ok ? { ok: true } : outcome;
      results.set(span, found);
    }
    return found;
  };

  /** Each piece copies its own line of the span's source (`piece.source`),
   * and the host's line breaks between pieces copy themselves, so a copy is
   * the source as written. */
  function Piece({ text, content }: { text: string; content: Content }) {
    const piece = pieces(content).find(
      (candidate) =>
        content.text.slice(candidate.start, candidate.end) === text,
    );
    if (!piece) return <>{text}</>;
    return <ProseMath piece={piece} text={text} />;
  }

  /** The engine reads, from the raw source, which host <br>s beside a piece
   * belong to its equation; the stylesheet hides those. */
  function classes(base: string, { joinBefore, joinAfter }: SegmentPiece) {
    return [
      base,
      joinBefore && "bzm-join-before",
      joinAfter && "bzm-join-after",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function ProseMath({ piece, text }: { piece: SegmentPiece; text: string }) {
    const { role, span, source } = piece;
    const outcome = React.useMemo(
      () => (role === "render" ? draw(span) : result(span)),
      [role, span],
    );
    if (!outcome.ok) {
      // A failed `$…$` may not be math at all.
      if (span.delimiter === "$") return <>{text}</>;
      return (
        <span className="bzm-invalid" title={outcome.message}>
          {source}
        </span>
      );
    }
    // Another part of a span: drawn by its render piece, so nothing shows.
    if (!outcome.element)
      return (
        <span className={classes("bzm-gap", piece)} hidden>
          {source}
        </span>
      );
    return (
      <span
        className={classes(span.display ? "bzm-display" : "bzm-math", piece)}
      >
        <Drawing className="bzm-draw" element={outcome.element} />
        {/* Selection copy reads this, so copied text keeps `$E=mc^2$`. */}
        <span className="bzm-src" aria-hidden="true">
          {source}
        </span>
        {/* The same Expand as a math fence; unselectable, so copy skips it. */}
        {span.display && (
          <span className="bzm-display-actions">
            <Expand tex={span.tex} />
          </span>
        )}
      </span>
    );
  }

  return {
    id: "prose",
    title: "Math in messages",
    matches: (content) =>
      pieces(content).map(({ start, end }) => ({ start, end })),
    component: Piece,
  };
}

/** Tints math whose hidden source is inside the selection, so the highlight
 * reads as continuous across equations. Returns the listener's removal. */
export function trackSelection(): () => void {
  const MATH = ".bzm-math, .bzm-display";
  let marked: Element[] = [];
  const clear = () => {
    for (const element of marked) element.removeAttribute("data-selected");
    marked = [];
  };
  const update = () => {
    clear();
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
      return;
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const scope = common instanceof Element ? common : common.parentElement;
    if (!scope) return;
    const inside = scope.closest(MATH);
    const candidates = inside
      ? [inside]
      : Array.from(scope.querySelectorAll(MATH));
    for (const element of candidates) {
      const source = element.querySelector(".bzm-src");
      if (source && range.intersectsNode(source)) {
        element.setAttribute("data-selected", "");
        marked.push(element);
      }
    }
  };
  document.addEventListener("selectionchange", update);
  return () => {
    document.removeEventListener("selectionchange", update);
    clear();
  };
}
