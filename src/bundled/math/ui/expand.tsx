// The Expand action and its dialog: a large view of one equation
// with Copy LaTeX and Copy MathML. Math fences show it in the host's code frame,
// display math in prose shows it beside the equation.
import type * as ReactNS from "react";
import type { Engine } from "../contract";
import type { Icons } from "./icons";
import { createDrawing } from "./drawing";

export type Copy = (text: string) => Promise<boolean>;

/** A button that opens the dialog for `tex`. Callers show it only for TeX that renders. */
export type Expand = ReactNS.ComponentType<{ tex: string }>;

export function createExpand(
  React: typeof ReactNS,
  engine: Engine,
  icons: Icons,
  copy: Copy,
): Expand {
  // Escape, the backdrop and Close all rely on the native modal dialog. A
  // WebView without one couldn't dismiss it, so there it isn't offered.
  if (
    typeof HTMLDialogElement !== "function" ||
    typeof HTMLDialogElement.prototype.showModal !== "function"
  )
    return () => null;
  const Drawing = createDrawing(React);
  // The dialog sits inside a message row in the DOM: its presses, menus and
  // copies are its own, not the row's.
  const stop = (event: ReactNS.SyntheticEvent) => event.stopPropagation();
  const contained = {
    onKeyDown: stop,
    onMouseDown: stop,
    onPointerDown: stop,
    onDoubleClick: stop,
    onContextMenu: stop,
    onCopy: stop,
  };

  /** A button that briefly confirms what it did. */
  function CopyButton({
    label,
    value,
  }: {
    label: string;
    value: string | undefined;
  }) {
    const [state, setState] = React.useState<
      "idle" | "busy" | "done" | "failed"
    >("idle");
    React.useEffect(() => {
      if (state !== "done" && state !== "failed") return;
      const timer = setTimeout(() => setState("idle"), 1500);
      return () => clearTimeout(timer);
    }, [state]);
    return (
      <button
        type="button"
        className="bzm-button"
        disabled={value === undefined || state === "busy"}
        aria-live="polite"
        onClick={() => {
          if (value === undefined) return;
          setState("busy");
          void copy(value).then((ok) => setState(ok ? "done" : "failed"));
        }}
      >
        {state === "done"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy"
            : label}
      </button>
    );
  }

  function ExpandDialog({ tex, onClose }: { tex: string; onClose(): void }) {
    const dialog = React.useRef<HTMLDialogElement>(null);
    const outcome = React.useMemo(() => engine.render(tex, true), [tex]);
    const mathml = React.useMemo(() => engine.toMathML(tex, true), [tex]);
    // Once shown, only a person closes it, so `close` always means theirs. No
    // cleanup closes it: unmounting removes it silently, and a cleanup close would
    // fire under React's development double effect and shut it on open.
    React.useEffect(() => {
      const node = dialog.current;
      if (node && !node.open) node.showModal();
    }, []);
    const titleId = React.useId();
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: The click only adds a pointer shortcut for the backdrop; Escape already closes a modal dialog.
      <dialog
        ref={dialog}
        className="bzm-dialog"
        aria-labelledby={titleId}
        {...contained}
        onClose={onClose}
        // A click on the backdrop lands on the dialog itself.
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="bzm-dialog-header">
          <h2 className="bzm-dialog-title" id={titleId}>
            Equation
          </h2>
          <button
            type="button"
            className="bzm-icon-button"
            aria-label="Close"
            title="Close"
            onClick={() => dialog.current?.close()}
          >
            <icons.Close />
          </button>
        </div>
        <div className="bzm-dialog-body">
          {outcome.ok && (
            <Drawing
              className="bzm-dialog-equation"
              element={outcome.element}
            />
          )}
          <pre className="bzm-dialog-source">{tex}</pre>
        </div>
        <div className="bzm-dialog-footer">
          <CopyButton label="Copy LaTeX" value={tex} />
          <CopyButton label="Copy MathML" value={mathml} />
          <button
            type="button"
            className="bzm-button"
            data-variant="prominent"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
      </dialog>
    );
  }

  return function Expand({ tex }: { tex: string }) {
    const [open, setOpen] = React.useState(false);
    const button = React.useRef<HTMLButtonElement>(null);
    return (
      <>
        <button
          type="button"
          ref={button}
          className="bzm-icon-button"
          aria-label="Expand equation"
          title="Expand equation"
          aria-haspopup="dialog"
          onClick={(event) => {
            // The button can sit inside a message row or a link: neither takes the click.
            event.stopPropagation();
            event.preventDefault();
            setOpen(true);
          }}
        >
          <icons.Expand />
        </button>
        {open && (
          <ExpandDialog
            tex={tex}
            onClose={() => {
              setOpen(false);
              button.current?.focus();
            }}
          />
        )}
      </>
    );
  };
}
