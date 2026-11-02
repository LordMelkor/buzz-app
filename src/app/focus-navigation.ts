import { focusWithKeyboard } from "../shared/design-system/useKeyboardFocusVisibility";

const PRIMARY = "[data-main-workspace], [data-solo-focus-pane]";
const WORKSPACE = `${PRIMARY}, [data-panel-workspace]`;
const COVERING = `${WORKSPACE}, [data-panel-dock]`;

function available(element: HTMLElement) {
  if (
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    !element.getClientRects().length
  )
    return false;
  const bounds = element.getBoundingClientRect();
  const front = document
    .elementsFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    )
    .find((hit) => hit.closest(COVERING))
    ?.closest(COVERING);
  // Skip notifications, but include dock content without its own workspace.
  return front === element.closest(COVERING);
}

function workspaces() {
  return Array.from(
    document
      .getElementById("main-content")
      ?.querySelectorAll<HTMLElement>(WORKSPACE) ?? [],
  );
}

function focusedWorkspace() {
  return document.activeElement?.closest<HTMLElement>(WORKSPACE);
}

/** A tool tab without a composer must never redirect typing to another pane. */
export function composerFocusTarget() {
  const main = document.getElementById("main-content");
  return composerIn(
    focusedWorkspace() ?? main?.querySelector<HTMLElement>(PRIMARY) ?? main,
  );
}

function composerIn(root: HTMLElement | null | undefined) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      '[data-tab-focus]:is([role="textbox"], input, textarea)',
    ) ?? [],
  ).find(
    (element) =>
      available(element) &&
      !element.matches(
        '[aria-disabled="true"], [disabled], [readonly], [contenteditable="false"]',
      ),
  );
}

/** Search selects a conversation in main, regardless of its previous focus. */
export function conversationComposerFocusTarget(channelId: string) {
  const conversation = document
    .getElementById("main-content")
    ?.querySelector(`[data-channel-workspace="${CSS.escape(channelId)}"]`);
  return composerIn(conversation?.querySelector<HTMLElement>(PRIMARY));
}

export function focusKeyboardTarget(target: HTMLElement | undefined) {
  if (!target) return;
  focusWithKeyboard(target);
}

/** Resume typing in a conversation; tool panes fall back to their selected tab. */
export function paneFocusTarget(pane?: "main" | "side") {
  const targets = workspaces()
    .filter(
      (workspace) =>
        !pane ||
        workspace.matches(pane === "main" ? PRIMARY : "[data-panel-workspace]"),
    )
    .map(
      (pane) =>
        composerIn(pane) ??
        pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    )
    .filter((target): target is HTMLElement => !!target && available(target));
  if (pane) return targets[0];
  const index = targets.findIndex(
    (target) => target.closest(WORKSPACE) === focusedWorkspace(),
  );
  return targets[(index + 1) % targets.length];
}
