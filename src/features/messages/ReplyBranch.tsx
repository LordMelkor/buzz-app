import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

/**
 * A reply with its nested replies. The branch opens from its summary and folds
 * back from its thread line.
 */
export function ReplyBranch({
  message,
  layout,
  summary,
  label,
  collapseLabel,
  hasReplies,
  open,
  depth,
  onExpand,
  onCollapse,
  children,
}: {
  message: ReactNode;
  layout: "thread" | "continuation";
  summary: ReactNode;
  label: string;
  collapseLabel: string;
  hasReplies: boolean;
  open: boolean;
  depth: number;
  onExpand(): void;
  onCollapse(): void;
  children: ReactNode;
}) {
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const summaryButton = useRef<HTMLButtonElement>(null);
  const focusRevealed = useRef(false);
  const focusSummary = useRef(false);
  useLayoutEffect(() => {
    if (open || !focusSummary.current) return;
    focusSummary.current = false;
    summaryButton.current?.focus({ preventScroll: true });
    summaryButton.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !focusRevealed.current) return;
    focusRevealed.current = false;
    const row = panel.current?.querySelector<HTMLElement>("[data-message-id]");
    if (row) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
    }
  }, [open]);
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    return () => {
      const row = element.querySelector<HTMLElement>("[data-message-id]");
      if (!row?.contains(document.activeElement)) return;
      recoverFocus(row, [
        element.parentElement?.parentElement
          ?.closest("[data-depth]")
          ?.querySelector<HTMLElement>("[data-message-id]"),
        threadHistory(element),
      ]);
    };
  }, []);
  // The thread line vanishes when live updates remove its replies or branch.
  const collapseRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement !== button) return;
      const branch = button.closest<HTMLElement>("[data-depth]");
      recoverFocus(button, [
        branch?.querySelector<HTMLElement>("[data-message-id]"),
        branch?.parentElement
          ?.closest("[data-depth]")
          ?.querySelector<HTMLElement>("[data-message-id]"),
        threadHistory(button),
      ]);
    };
  }, []);
  return (
    <div
      className={styles.replyBranch}
      data-depth={Math.min(depth, 6)}
      data-open={open && hasReplies}
      data-layout={layout}
    >
      <div ref={messageRef} className={styles.replyBranchMessage}>
        {message}
      </div>
      {hasReplies && !open && (
        <div className={styles.replyBranchSummary}>
          <Button
            ref={summaryButton}
            variant="link"
            size="sm"
            data-thread-summary=""
            aria-label={label}
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => {
              focusRevealed.current = true;
              onExpand();
            }}
          >
            {summary}
          </Button>
        </div>
      )}
      <div
        id={panelId}
        ref={panel}
        className={styles.replyBranchPanel}
        hidden={!open}
      >
        {open && hasReplies && (
          <button
            ref={collapseRef}
            type="button"
            className={styles.replyBranchCollapse}
            aria-label={collapseLabel}
            aria-expanded
            aria-controls={panelId}
            onClick={() => {
              focusSummary.current = true;
              onCollapse();
            }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

function threadHistory(element: HTMLElement) {
  return element.closest<HTMLElement>('[aria-label="Thread messages"]');
}

/** Moves focus lost with a removed element to the first surviving target. */
function recoverFocus(
  removed: HTMLElement,
  targets: readonly (HTMLElement | null | undefined)[],
) {
  queueMicrotask(() => {
    // Exact-link reparenting and explicit collapse restore focus during layout;
    // never override them or a user who has deliberately moved elsewhere.
    if (removed.isConnected || document.activeElement !== document.body) return;
    const target = targets.find((element) => element?.isConnected);
    if (!target || target.closest("[inert]")) return;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
}
