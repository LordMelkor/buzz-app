// the composer's Equation tool (Σ). A popover in the top
// layer, so the composer's clipping never cuts it, with a live preview.
import type * as ReactNS from "react";
import { trimTex, type Engine, type RenderOutcome } from "../contract";
import type { ComposerTool } from "./host";
import type { Icons } from "./icons";
import { createDrawing } from "./drawing";
import { PROSE } from "./inline";
import { type Directory, references } from "./references";

type ToolProps = ReactNS.ComponentProps<ComposerTool["component"]>;

// jsdom and WebKit before Safari 17 lack the Popover API: fall back to plain visibility.
const nativePopover =
  typeof HTMLElement !== "undefined" &&
  typeof HTMLElement.prototype.showPopover === "function";

/** The draft text Insert adds. */
export function equationText(tex: string, display: boolean): string {
  // A blank line would end the message's paragraph, and the math with it.
  // KaTeX reads it as a space, so one line break draws the same equation.
  const body = trimTex(tex).replace(/\n\s*\n/g, "\n");
  if (display) return `\n$$\n${body}\n$$\n`;
  // `$…$` needs non-space edges; a terminal control-space uses explicit parens.
  // A closing `$` before a digit reads as a price, and the tool can't see what
  // follows the caret, so a space keeps the equation whatever comes next.
  return /[$\n]|\s$/.test(body) ? `\\(${body}\\)` : `$${body}$ `;
}

/** One-click structures for people who don't know the LaTeX.
 * `slot` is the placeholder that the selection fills, or that ends up selected;
 * once a selection fills it, `next` is the placeholder to type over. */
export type Template = Readonly<{
  name: string;
  glyph: string;
  tex: string;
  slot: string;
  next?: string;
  display?: boolean;
}>;

export const TEMPLATES: readonly Template[] = [
  {
    name: "Fraction",
    glyph: "\\frac{a}{b}",
    tex: "\\frac{a}{b}",
    slot: "a",
    next: "b",
  },
  { name: "Superscript", glyph: "x^n", tex: "^{n}", slot: "n" },
  { name: "Subscript", glyph: "x_i", tex: "_{i}", slot: "i" },
  { name: "Square root", glyph: "\\sqrt{x}", tex: "\\sqrt{x}", slot: "x" },
  {
    name: "Root",
    glyph: "\\sqrt[n]{x}",
    tex: "\\sqrt[n]{x}",
    slot: "x",
    next: "n",
  },
  {
    name: "Sum",
    glyph: "\\textstyle\\sum",
    tex: "\\sum_{i=1}^{n} x_i",
    slot: "x_i",
  },
  {
    name: "Integral",
    glyph: "\\textstyle\\int",
    tex: "\\int_{a}^{b} f(x)\\,dx",
    slot: "f(x)",
  },
  {
    name: "Limit",
    glyph: "\\lim",
    tex: "\\lim_{x \\to \\infty} f(x)",
    slot: "f(x)",
  },
  {
    name: "Matrix",
    glyph: "\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}",
    tex: "\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}",
    slot: "a",
    display: true,
  },
  {
    name: "Cases",
    glyph: "\\begin{cases}a\\\\b\\end{cases}",
    tex: "f(x) = \\begin{cases}\na & x > 0 \\\\\nb & x \\le 0\n\\end{cases}",
    slot: "a",
    display: true,
  },
  {
    name: "Aligned",
    glyph: "\\begin{smallmatrix}a&=b\\\\&=c\\end{smallmatrix}",
    tex: "\\begin{aligned}\na &= b \\\\\n&= c\n\\end{aligned}",
    slot: "b",
    display: true,
  },
  {
    name: "Chemistry",
    glyph: "\\ce{H2O}",
    tex: "\\ce{2H2 + O2 -> 2H2O}",
    slot: "2H2 + O2 -> 2H2O",
  },
];

/** Where `text` stands on its own in `tex`: not part of a command or an
 * environment name, so the `a` of `\frac` or `pmatrix` never counts. */
function placeholder(tex: string, text: string): number {
  for (let at = tex.indexOf(text); at >= 0; at = tex.indexOf(text, at + 1)) {
    if (
      !/[A-Za-z\\]/.test(tex[at - 1] ?? "") &&
      !/[A-Za-z]/.test(tex[at + text.length] ?? "")
    )
      return at;
  }
  return -1;
}

/** The field after a template goes in at [start, end): a selection fills the
 * slot and then `next`, or else the caret, is selected; otherwise the slot is. */
export function applyTemplate(
  value: string,
  start: number,
  end: number,
  template: Template,
) {
  const { tex: raw, slot, next } = template;
  const selected = value.slice(start, end);
  const at = placeholder(raw, slot);
  const tex = selected
    ? raw.slice(0, at) + selected + raw.slice(at + slot.length)
    : raw;
  const result = (from: number, to = from) => ({
    value: value.slice(0, start) + tex + value.slice(end),
    selection: [start + from, start + to] as [number, number],
  });
  if (!selected) return result(at, at + slot.length);
  const nextAt = next === undefined ? -1 : placeholder(raw, next);
  if (next === undefined || nextAt < 0) return result(tex.length);
  // `next` before the slot keeps its place; after it, it moves by the filling.
  const shifted = nextAt > at ? nextAt + selected.length - slot.length : nextAt;
  return result(shifted, shifted + next.length);
}

/** `directory` is the host's cached names, read as the message's prose will read them. */
export function createEquationTool(
  React: typeof ReactNS,
  engine: Engine,
  icons: Icons,
  directory: () => Directory | undefined,
): ComposerTool {
  const Drawing = createDrawing(React);

  /** Why Insert is unavailable, or undefined. The message must show what the
   * preview shows: KaTeX parses the equation, and the detector reads the
   * inserted text back as exactly this one equation. */
  function findProblem(
    tex: string,
    display: boolean,
    outcome: RenderOutcome,
  ): string | undefined {
    if (!outcome.ok) return outcome.message;
    const text = equationText(tex, display);
    // One span over the whole insertion, which a message draws; its delimiters
    // already say inline or display. The insertion names no recipients, and
    // sending tags any community emoji shortcode it contains.
    const host = directory();
    const draft = {
      content: text,
      mentions: [],
      emoji: host?.emoji?.snapshot().entries,
    };
    const index = engine.index(text, {
      ...PROSE,
      references: references(draft, host),
    });
    const one =
      index.spans.length === 1 &&
      index.drawn.length === 1 &&
      index.spans[0]?.source === text.trim();
    return one ? undefined : "A message can't show this as one equation";
  }

  function Preview({
    outcome,
    problem,
  }: {
    outcome: RenderOutcome | undefined;
    problem: string | undefined;
  }) {
    return (
      <>
        <div className="bzm-preview" aria-hidden="true">
          {outcome?.ok ? (
            <Drawing element={outcome.element} />
          ) : (
            <span className="bzm-preview-empty">
              {outcome ? "" : "Preview"}
            </span>
          )}
        </div>
        <div
          className="bzm-hint"
          data-tone={problem ? "danger" : undefined}
          aria-live="polite"
        >
          {problem ?? "⌘↩ inserts"}
        </div>
      </>
    );
  }

  /** Mounted each time the tool opens; the engine memoizes the glyphs, so a
   * reopen only clones them. */
  function Templates({ onPick }: { onPick(template: Template): void }) {
    const drawn = React.useMemo(
      () =>
        TEMPLATES.map((template) => ({
          template,
          glyph: engine.render(template.glyph, false),
        })),
      [],
    );
    return (
      // biome-ignore lint/a11y/useSemanticElements: A fieldset's default box would change this button grid's layout.
      <div className="bzm-templates" role="group" aria-label="Templates">
        {drawn.map(({ template, glyph }) => (
          <button
            key={template.name}
            type="button"
            className="bzm-template"
            aria-label={template.name}
            title={template.name}
            // Keep the field's selection: the template may wrap it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(template)}
          >
            {glyph.ok ? <Drawing element={glyph.element} /> : template.name}
          </button>
        ))}
      </div>
    );
  }

  function EquationTool({ disabled, insertText, focus }: ToolProps) {
    const button = React.useRef<HTMLButtonElement>(null);
    const popover = React.useRef<HTMLDivElement>(null);
    const field = React.useRef<HTMLTextAreaElement>(null);
    // Closed <-> Open. With the Popover API the browser owns this
    // state: Σ is the popover's invoker, so Σ, light dismiss and Esc all toggle
    // natively, and `open` only mirrors the toggle events. Without the API,
    // `open` is the state.
    const [open, setOpen] = React.useState(false);
    const [tex, setTex] = React.useState("");
    const [display, setDisplay] = React.useState(false);
    const outcome = React.useMemo(() => {
      const body = trimTex(tex);
      return body ? engine.render(body, display) : undefined;
    }, [tex, display]);
    // Not memoized: the names a message binds can change while the TeX doesn't.
    // The engine caches each index, so checking at every render is cheap.
    const problem = outcome && findProblem(tex, display, outcome);
    const [, recheck] = React.useReducer((n: number) => n + 1, 0);
    const valid = outcome !== undefined && problem === undefined;
    const ids = {
      popover: React.useId(),
      field: React.useId(),
      hint: React.useId(),
    };
    // Where the field's selection goes once a template's text is in.
    const pending = React.useRef<[number, number] | null>(null);
    React.useLayoutEffect(() => {
      const node = field.current;
      if (!node || !pending.current) return;
      node.focus();
      node.setSelectionRange(...pending.current);
      pending.current = null;
    }, [tex]);
    const pick = (template: Template) => {
      const node = field.current;
      const next = applyTemplate(
        tex,
        node?.selectionStart ?? tex.length,
        node?.selectionEnd ?? tex.length,
        template,
      );
      pending.current = next.selection;
      setTex(next.value);
      // Matrices, cases and aligned rows read best on their own lines.
      if (template.display) setDisplay(true);
    };

    React.useEffect(() => {
      const node = popover.current;
      if (!node || !nativePopover) return;
      const onToggle = (event: Event) =>
        setOpen((event as ToggleEvent).newState === "open");
      node.addEventListener("toggle", onToggle);
      return () => node.removeEventListener("toggle", onToggle);
    }, []);
    React.useEffect(() => {
      if (open) field.current?.focus();
    }, [open]);

    const close = () => {
      if (!nativePopover) setOpen(false);
      else if (popover.current?.matches(":popover-open"))
        popover.current.hidePopover();
    };
    /** Esc or Cancel: close, keep the draft, return focus to Σ. */
    const cancel = () => {
      close();
      button.current?.focus();
    };
    // A composer that turns disabled (sending, read-only) closes the tool.
    React.useEffect(() => {
      if (disabled) close();
    }, [disabled]);

    /** Anchors the popover above Σ; the stylesheet clamps it to the viewport. */
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      if (!anchor || !popover.current) return;
      popover.current.style.setProperty(
        "--bzm-anchor-left",
        `${anchor.left}px`,
      );
      popover.current.style.setProperty(
        "--bzm-anchor-bottom",
        `${window.innerHeight - anchor.top + 8}px`,
      );
    };
    const insert = () => {
      if (!valid || disabled) return;
      // Check the directory as it is now, and show why if it no longer passes.
      if (findProblem(tex, display, outcome)) return recheck();
      if (!insertText(equationText(tex, display))) return;
      setTex("");
      close();
      focus();
    };

    return (
      <>
        <button
          type="button"
          ref={button}
          className="bzm-icon-button"
          disabled={disabled}
          aria-label="Equation"
          title="Equation"
          aria-haspopup="dialog"
          aria-expanded={open}
          popoverTarget={nativePopover ? ids.popover : undefined}
          // Runs before the native toggle, so the popover opens already in place.
          onClick={() => {
            place();
            if (!nativePopover) setOpen(!open);
          }}
        >
          <icons.Sigma />
        </button>
        <div
          ref={popover}
          id={ids.popover}
          className="bzm-popover"
          popover="auto"
          role="dialog"
          aria-label="Insert equation"
          style={
            nativePopover ? undefined : { display: open ? "grid" : "none" }
          }
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              insert();
            } else if (event.key === "Escape") cancel();
          }}
        >
          {open && <Templates onPick={pick} />}
          <div className="bzm-field">
            <label className="bzm-label" htmlFor={ids.field}>
              LaTeX
            </label>
            <textarea
              ref={field}
              id={ids.field}
              className="bzm-textarea"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="\frac{a}{b}"
              value={tex}
              aria-describedby={ids.hint}
              aria-invalid={problem !== undefined}
              onChange={(event) => setTex(event.target.value)}
            />
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: A fieldset's default box would change this segmented control's layout. */}
          <div className="bzm-segment" role="group" aria-label="Layout">
            <button
              type="button"
              aria-pressed={!display}
              onClick={() => setDisplay(false)}
            >
              Inline
            </button>
            <button
              type="button"
              aria-pressed={display}
              onClick={() => setDisplay(true)}
            >
              Display
            </button>
          </div>
          <div id={ids.hint}>
            {open && <Preview outcome={outcome} problem={problem} />}
          </div>
          <div className="bzm-actions">
            <button type="button" className="bzm-button" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="bzm-button"
              data-variant="prominent"
              disabled={!valid || disabled}
              onClick={insert}
            >
              Insert
            </button>
          </div>
        </div>
      </>
    );
  }

  return { id: "equation", title: "Equation", component: EquationTool };
}
