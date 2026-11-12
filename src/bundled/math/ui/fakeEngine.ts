// A predictable Engine for UI tests: no KaTeX, no fonts.
import type {
  Engine,
  MathIndex,
  MathSpan,
  RenderOutcome,
  SegmentPiece,
} from "../contract";

/** Renders `tex` as `<span class="katex" data-tex>tex</span>`; "\\bad" fails. */
export function fakeRender(tex: string, display: boolean): RenderOutcome {
  if (tex.includes("\\bad"))
    return {
      ok: false,
      message: "Undefined control sequence: \\bad",
      position: tex.indexOf("\\bad"),
    };
  if (tex.length > 10_000)
    return { ok: false, message: "Too long to typeset", tooLarge: true };
  const inner = document.createElement("span");
  inner.className = "katex";
  inner.dataset.tex = tex;
  inner.textContent = tex;
  if (!display) return { ok: true, element: inner };
  const outer = document.createElement("span");
  outer.className = "katex-display";
  outer.append(inner);
  return { ok: true, element: outer };
}

/** Pieces from a fixed table: segment text -> pieces. */
export function fakeIndex(
  table: Record<string, readonly SegmentPiece[]>,
): MathIndex {
  const spans: MathSpan[] = [];
  for (const pieces of Object.values(table))
    for (const piece of pieces)
      if (!spans.includes(piece.span)) spans.push(piece.span);
  return { spans, drawn: spans, pieces: (segment) => table[segment] ?? [] };
}

export function span(
  source: string,
  tex: string,
  display = false,
  delimiter: MathSpan["delimiter"] = display ? "$$" : "$",
): MathSpan {
  return { source, tex, display, delimiter, start: 0, end: source.length };
}

export function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  return {
    // By default a draft reads back as one span: what the Equation tool checks.
    index: (content) => {
      const whole = span(content.trim(), content.trim());
      return { spans: [whole], drawn: [whole], pieces: () => [] };
    },
    render: fakeRender,
    toMathML: (tex) =>
      `<math><annotation encoding="application/x-tex">${tex}</annotation></math>`,
    fenceMode: (language) => {
      const name = language.trim().toLowerCase();
      if (name === "math" || name === "katex") return "math";
      if (name === "latex" || name === "tex") return "latex";
      return null;
    },
    commands: (prefix, limit) =>
      [
        {
          name: "\\alpha",
          detail: "Greek letter",
          preview: "\\alpha",
          insert: "\\alpha",
        },
        {
          name: "\\aleph",
          detail: "Hebrew letter",
          preview: "\\aleph",
          insert: "\\aleph",
        },
        {
          name: "\\frac",
          detail: "Fraction",
          preview: "\\frac{a}{b}",
          insert: "\\frac{}{}",
        },
      ]
        .filter(
          (command) => prefix.length > 1 && command.name.startsWith(prefix),
        )
        .slice(0, limit),
    // Real rules live in the engine (detect.ts); here "inside" means an unclosed `$`.
    insideMath: (before) => (before.match(/\$/g)?.length ?? 0) % 2 === 1,
    install: () => () => {},
    tool: {
      name: "math_check",
      description: "fake",
      inputSchema: { type: "object" },
      call: async () => "ok",
    },
    ...overrides,
  };
}
