// The plugin's one stylesheet: host tokens and rem only, every
// selector under the `bzm-` prefix. KaTeX's
// own layout CSS is the engine's (install()); this file only places it.

export const STYLE_ID = "com.squareup.math:ui";

const focus = (selector: string) =>
  `html[data-keyboard-navigation] ${selector}:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }`;

const thinScroll = `scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb-quiet) transparent;`;

export const styles = `
/* Prose: inline. TeX's x-height is smaller than Inter's; 1.15em balances it. */
.bzm-math { position: relative; white-space: nowrap; }
.bzm-math .katex { font-size: 1.15em; }
/* TeX can move ink anywhere (\\llap, \\kern, \\smash); trust:false stops links,
   not that. A sender's math paints only inside its own box, never over a byline.
   clip-path, not overflow: an inline-block that clips overflow sits on its bottom
   edge in WebKit, not on the text baseline. The inset leaves room for italic
   and accent overhang. */
.bzm-math > .bzm-draw { display: inline-block; clip-path: inset(-0.15em); }
/* The drawing never copies; the hidden source beside it does. */
.bzm-draw { -webkit-user-select: none; user-select: none; }
.bzm-src { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: pre; }
.bzm-math[data-selected] .bzm-draw,
.bzm-display[data-selected] .bzm-draw {
  background: var(--selection-fill, var(--surface-text-selection));
  color: var(--selection-text, var(--text-on-selection));
  border-radius: var(--space-1);
}

/* Prose: display. Flush left with an indent keeps the reading line. */
.bzm-display { position: relative; display: block; margin-block: var(--space-2); padding-inline-start: var(--space-6); }
/* The drawing scrolls, not the block, so Expand stays put beside even a wide
   equation. Expand sits in the indent, so it takes no width from the drawing
   and never covers it, even in a bubble that fits the equation exactly. */
.bzm-display > .bzm-draw { display: block; overflow-x: auto; overflow-y: hidden; ${thinScroll} }
.bzm-display-actions { position: absolute; inset-block-start: 0; inset-inline-start: 0; display: flex;
  -webkit-user-select: none; user-select: none; }
.bzm-display-actions > .bzm-icon-button { width: var(--space-6); height: var(--space-6); }
/* Shown on hover or focus where there is a pointer; always there on touch. */
@media (hover: hover) and (pointer: fine) {
  .bzm-display-actions { opacity: 0; transition: opacity var(--duration-fast, 120ms) ease-out; }
  .bzm-display:hover > .bzm-display-actions, .bzm-display-actions:focus-within { opacity: 1; }
}
.bzm-display > .bzm-draw .katex-display { margin: 0; }
/* KaTeX numbers align rows with a counter it resets on <body>. A virtualized
   timeline mounts rows out of order, so each block numbers from (1). */
.bzm-display, .bzm-fence, .bzm-dialog-equation, .bzm-preview { counter-reset: katexEqnNo mmlEqnNo; }
/* KaTeX pins \tag and align numbers to the right edge; in a message that
   shrinks to its content they would overlap the equation, so they follow it. */
.bzm-display > .bzm-draw .katex-display > .katex > .katex-html > .tag { position: static; padding-inline-start: 2em; }
/* Hidden lines leave the host's <br>s behind; the engine marks the ones that
   belong to the equation (joinBefore, joinAfter); shown, they would add blank lines. */
br:has(+ .bzm-join-before), .bzm-join-after + br { display: none; }
/* Prose: math that the author clearly meant but that does not parse. */
.bzm-invalid { text-decoration: underline dotted var(--border-danger); text-underline-offset: 0.2em; white-space: pre-wrap; }

/* Fence: centered in the host's code frame, or alone in a panel. */
.bzm-fence { display: block; box-sizing: border-box; width: 100vw; max-width: 100%; padding: var(--space-3);
  overflow-x: auto; overflow-y: hidden; text-align: center; color: var(--text-standard); ${thinScroll} }
.bzm-fence .katex-display { margin: 0; }
.bzm-error, .bzm-source { padding: var(--space-3); font-family: var(--font-mono); font-size: var(--text-mono);
  line-height: var(--text-mono--line-height); letter-spacing: var(--text-mono--letter-spacing); font-weight: var(--text-mono--font-weight); }
.bzm-error { padding-bottom: 0; color: var(--text-danger); white-space: pre-wrap; overflow-wrap: anywhere; }
.bzm-source { overflow-x: auto; white-space: pre; color: var(--text-standard); ${thinScroll} }

/* Controls, matching the host's ghost IconButton and capsule Button. */
.bzm-icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; box-sizing: border-box;
  width: 2rem; height: 2rem; padding: 0; border: 0; border-radius: var(--radius-icon-button, var(--radius-pill));
  background: transparent; color: var(--text-standard); cursor: pointer; }
.bzm-icon-button:disabled { color: var(--text-unavailable); cursor: default; }
.bzm-icon-button[aria-expanded="true"] { background: var(--affordance-subtle-pressed, var(--affordance-subtle)); }
.bzm-button { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); flex: none; white-space: nowrap;
  box-sizing: border-box; min-height: 2rem; padding: 0 var(--space-4); border: 0; border-radius: var(--radius-capsule); cursor: pointer;
  font: inherit; font-size: var(--text-label-sm); font-weight: var(--text-label-sm--font-weight); line-height: var(--text-label-sm--line-height);
  background: var(--affordance-subtle); color: var(--text-standard); }
.bzm-button[data-variant="prominent"] { background: var(--affordance-prominent); color: var(--text-on-prominent); }
.bzm-button:disabled { background: var(--affordance-disabled); color: var(--text-unavailable); cursor: default; }
@media (hover: hover) and (pointer: fine) {
  .bzm-icon-button:hover:not(:disabled) { background: var(--affordance-subtle-hover); }
  .bzm-button:hover:not(:disabled) { background: var(--affordance-subtle-hover); }
  .bzm-button[data-variant="prominent"]:hover:not(:disabled) { background: var(--affordance-prominent-hover); }
}
${focus(".bzm-icon-button")}
${focus(".bzm-button")}
${focus(".bzm-segment button")}

/* Expand dialog: the native modal (focus trap, Esc, top layer). margin: auto
   centers it, because the host's CSS reset zeroes the browser's margin. */
.bzm-dialog { box-sizing: border-box; width: min(56rem, calc(100vw - var(--space-8))); max-height: calc(100vh - var(--space-8));
  margin: auto; padding: 0; border: 0; border-radius: var(--radius-panel); background: var(--surface-popover); color: var(--text-standard);
  box-shadow: var(--shadow-panel); font-family: var(--font-sans); -webkit-user-select: text; user-select: text; }
.bzm-dialog[open] { display: flex; flex-direction: column; }
.bzm-dialog::backdrop { background: var(--bg-scrim); }
.bzm-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  padding: var(--space-4) var(--space-4) 0 var(--space-6); }
.bzm-dialog-title { margin: 0; font-size: var(--text-heading); line-height: var(--text-heading--line-height); font-weight: var(--text-heading--font-weight, 500); }
.bzm-dialog-body { display: grid; gap: var(--space-4); min-height: 0; overflow: auto; padding: var(--space-4) var(--space-6); ${thinScroll} }
.bzm-dialog-equation { overflow-x: auto; overflow-y: hidden; padding-block: var(--space-4); text-align: center; ${thinScroll} }
.bzm-dialog-equation .katex { font-size: 1.6em; }
.bzm-dialog-equation .katex-display { margin: 0; }
.bzm-dialog-source { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius-control); background: var(--surface-inset);
  font-family: var(--font-mono); font-size: var(--text-mono); line-height: var(--text-mono--line-height);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.bzm-dialog-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); padding: 0 var(--space-6) var(--space-6); }

/* Composer Equation tool. */
.bzm-popover { --bzm-popover-width: min(22rem, calc(100vw - var(--space-4)));
  /* One column that never grows past the popover: long previews scroll inside it. */
  grid-template-columns: minmax(0, 1fr); gap: var(--space-3);
  box-sizing: border-box; width: var(--bzm-popover-width); margin: 0; padding: var(--space-4);
  /* Above Σ (composer.tsx sets the anchor), kept inside the viewport. */
  position: fixed; inset: auto auto var(--bzm-anchor-bottom, var(--space-2))
    clamp(var(--space-2), var(--bzm-anchor-left, var(--space-2)), calc(100vw - var(--bzm-popover-width) - var(--space-2)));
  /* A tall draft or a dragged field scrolls inside it, never past the window's top. */
  max-height: calc(100dvh - var(--bzm-anchor-bottom, var(--space-2)) - var(--space-2)); overflow-y: auto; ${thinScroll}
  border: 1px solid var(--border-standard); border-radius: var(--radius-container); background: var(--surface-popover);
  color: var(--text-standard); box-shadow: var(--shadow-panel); font-family: var(--font-sans); }
.bzm-popover:popover-open { display: grid; }
.bzm-templates { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--space-1); }
.bzm-template { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 2.75rem; padding: 0;
  border: 0; border-radius: var(--radius-control); background: var(--surface-inset); color: var(--text-standard); cursor: pointer;
  overflow: hidden; font-size: var(--text-body-sm, 0.875rem); }
.bzm-template .katex { font-size: 1.25em; }
@media (hover: hover) and (pointer: fine) { .bzm-template:hover { background: var(--affordance-subtle-hover); } }
${focus(".bzm-template")}
.bzm-field { display: grid; gap: var(--space-1); }
.bzm-label { font-size: var(--text-label-sm); font-weight: var(--text-label-sm--font-weight); line-height: var(--text-label-sm--line-height); }
.bzm-textarea { box-sizing: border-box; width: 100%; min-height: 4.5rem; padding: var(--space-2) var(--space-3); resize: vertical;
  font-family: var(--font-mono); font-size: var(--text-mono); line-height: var(--text-mono--line-height);
  color: var(--text-standard); background: var(--surface-inset); border: 1px solid var(--border-prominent); border-radius: var(--radius-control); outline: 0; }
.bzm-textarea::placeholder { color: var(--text-metadata); }
.bzm-textarea:focus-visible { border-color: var(--border-focus); }
.bzm-textarea[aria-invalid="true"] { border-color: var(--border-danger); }
.bzm-segment { display: inline-flex; justify-self: start; padding: var(--space-half); border-radius: var(--radius-capsule); background: var(--surface-inset); }
.bzm-segment button { min-height: 1.75rem; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-capsule); background: transparent;
  font: inherit; font-size: var(--text-label-sm); font-weight: var(--text-label-sm--font-weight); color: var(--text-subtle); cursor: pointer; }
.bzm-segment button[aria-pressed="true"] { background: var(--surface-panel); color: var(--text-standard); box-shadow: var(--shadow-xs); }
.bzm-preview { display: flex; align-items: center; min-height: 3rem; padding: var(--space-3);
  border-radius: var(--radius-control); background: var(--surface-panel); overflow-x: auto; overflow-y: hidden; ${thinScroll} }
/* Auto margins center it, yet a long equation still scrolls back to its start. */
.bzm-preview > * { margin-inline: auto; }
.bzm-preview .katex { font-size: 1.4em; } /* larger than in messages, so typos show */
.bzm-preview .katex-display { margin: 0; }
.bzm-preview-empty { color: var(--text-metadata); font-size: var(--text-body-sm); }
.bzm-hint { min-height: var(--text-caption--line-height, 1rem); font-size: var(--text-caption); line-height: var(--text-caption--line-height); color: var(--text-metadata); overflow-wrap: anywhere; }
.bzm-hint[data-tone="danger"] { color: var(--text-danger); }
.bzm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }

/* Completion previews. */
.bzm-suggestion { display: inline-flex; align-items: center; justify-content: center; min-width: 1.5rem; }
.bzm-suggestion .katex { font-size: 1em; }

@media (prefers-reduced-motion: reduce) { .bzm-button, .bzm-icon-button, .bzm-display-actions { transition: none; } }
`;

/** Adds the stylesheet once; returns its removal. */
export function installStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.plugin = STYLE_ID;
  style.textContent = styles;
  document.head.append(style);
  return () => style.remove();
}
