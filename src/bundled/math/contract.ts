// The only coupling between ui/ + index.tsx and engine/.

/** Remove delimiter/editor padding without deleting a terminal TeX control
 * space. An odd terminal slash run consumes one following whitespace token. */
export function trimTex(tex: string): string {
  const end = tex.trimEnd(),
    body = end.trimStart();
  let slash = body.length;
  while (body[slash - 1] === "\\") slash--;
  return end.length < tex.length && (body.length - slash) % 2
    ? `${body} `
    : body;
}

// §1 Detection

/** How a span was written. `env` is a bare \begin{E}…\end{E}; `fence` a code block. */
export type Delimiter = "$" | "$$" | "\\(" | "\\[" | "env" | "fence";

/** One piece of math found in a message's raw Markdown source. */
export type MathSpan = Readonly<{
  /** TeX handed to the renderer: raw source between delimiters, trimTex-normalized,
   * with Markdown container prefixes removed on continuation lines.
   * For `env`, the whole \begin…\end text, with the same prefix removal. */
  tex: string;
  display: boolean;
  delimiter: Delimiter;
  /** Written source including delimiters, with Markdown container prefixes
   * removed on continuation lines. The host's copy serializer restores them.
   * Single-line source stays byte-exact. */
  source: string;
  /** UTF-16 offsets of the original raw span in message content, before
   * container-prefix removal. */
  start: number;
  end: number;
}>;

/** What to draw for one range of one host text segment. */
export type SegmentPiece = Readonly<{
  /** UTF-16 range within the segment text passed to `pieces`. */
  start: number;
  end: number;
  /** `render`: draw the whole span here. `hide`: draw nothing (other part of a span). */
  role: "render" | "hide";
  /** Raw copy text for this source line, without container prefixes or a line
   * ending. Prefer the line's first unformatted piece, otherwise its first
   * formatted piece; all others carry "". Host BRs supply LF between lines. */
  source: string;
  /** The host <br> before/after this piece belongs to the equation, so the UI hides it.
   * Only container prefixes and whitespace may sit between them in the raw source.
   * before: the piece starts its physical line, and it is a later source line of the span or the span is display.
   * after: the span is display and the piece ends its physical line. */
  joinBefore: boolean;
  joinAfter: boolean;
  span: MathSpan;
}>;

export type DetectOptions = Readonly<{
  /** Rule 2.1.2: single-dollar inline math. Default true. */
  singleDollar: boolean;
  /** Cached host reference context. Names have no @/# prefix. `names` contains
   * only signed-recipient aliases (none for an edited body), unique per identity.
   * Repeat an alias for distinct identities: that name is ambiguous, not bound.
   * Channels follow the host's joined/open-directory precedence, unique per id.
   * Omit this field for standalone drafts/tools (no host bindings). Prose
   * always supplies it, even empty: unresolved @names leave their paragraph
   * as text until the cached context arrives. */
  references?: Readonly<{
    names: readonly string[];
    channels: readonly string[];
    /** Message emoji shortcodes, passed as-is. Recognized overlapping emoji
     * make the whole equation unmappable; omitted/empty means no emoji matches. */
    emoji?: readonly string[];
  }>;
}>;

export type MathIndex = Readonly<{
  /** Every detected span, in source order, including ones dropped from mapping. */
  spans: readonly MathSpan[];
  /** Spans with a surviving render anchor after mapping/consistency checks,
   * in source order. Subset of `spans`; this does not validate KaTeX syntax. */
  drawn: readonly MathSpan[];
  /** Pieces for one host segment (InlineContent.text), sorted, non-overlapping,
   * each range non-empty and inside the segment. [] when none. Pure and O(1)
   * amortised: called for every segment of every rendered message. */
  pieces(segment: string): readonly SegmentPiece[];
}>;

// §2 Rendering

export type RenderOutcome =
  | Readonly<{
      ok: true;
      /** A fresh KaTeX element (`span.katex`, or `span.katex-display` when
       * display) owned by the caller: a clone, safe to append once. */
      element: HTMLElement;
    }>
  | Readonly<{
      ok: false;
      /** One line, user-readable (KaTeX ParseError rawMessage or our cap text). */
      message: string;
      /** UTF-16 offset of the error in `tex`, when known. */
      position?: number;
      /** True when refused by a size cap rather than a parse error. */
      tooLarge?: boolean;
    }>;

export type RenderOptions = Readonly<{
  /** Flush-left display layout (KaTeX fleqn); prose display uses it, fences do not. */
  fleqn?: boolean;
}>;

/** How a fenced code block language is treated. `math`: render, show errors.
 * `latex`: render only when it parses, else the UI throws so the host shows code. */
export type FenceMode = "math" | "latex";

// §3 Composer completion data

export type CommandInfo = Readonly<{
  /** With the backslash, e.g. "\\alpha". */
  name: string;
  /** Short category label shown as the suggestion detail, e.g. "Greek letter". */
  detail: string;
  /** TeX to render as the preview, e.g. "\\alpha" or "\\frac{a}{b}". */
  preview: string;
  /** Text inserted in place of the typed prefix (usually `name`; may add "{}"). */
  insert: string;
}>;

// §4 Agent tool (shape of the host AddedTool, buzz-app src/buzz-mcp/session-tools.ts)

export type AgentTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  call(
    client: unknown,
    context: unknown,
    args: Record<string, unknown>,
  ): Promise<string>;
}>;

// §5 The engine

export type Engine = Readonly<{
  /** Memoized by (content, options). Never throws; a broken message yields no spans. */
  index(content: string, options: DetectOptions): MathIndex;
  /** Memoized by (tex, display, options); always returns a fresh element. Never throws. */
  render(tex: string, display: boolean, options?: RenderOptions): RenderOutcome;
  /** MathML markup (with TeX annotation) for Copy MathML; undefined on error. */
  toMathML(tex: string, display: boolean): string | undefined;
  fenceMode(language: string): FenceMode | null;
  /** Up to `limit` commands starting with `prefix` (with backslash), best first. */
  commands(prefix: string, limit: number): readonly CommandInfo[];
  /** True when `before` (a draft up to the caret) ends inside math the
   * detector would typeset once closed. Never throws. */
  insideMath(before: string): boolean;
  /** Inject the KaTeX stylesheet and register fonts. Idempotent; returns cleanup. */
  install(): () => void;
  tool: AgentTool;
}>;
