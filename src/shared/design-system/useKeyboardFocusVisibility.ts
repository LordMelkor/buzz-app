import { useEffect } from "react";

const KEYBOARD_NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

/** Explicit keyboard focus actions also use this owner after being rebound. */
function showKeyboardFocus() {
  document.documentElement.dataset.keyboardNavigation = "";
}

export function focusWithKeyboard(element: HTMLElement) {
  showKeyboardFocus();
  // Chromium ignores focus options when the control is already focused.
  if (document.activeElement === element && !element.matches(":focus-visible"))
    element.blur();
  const options: FocusOptions & { focusVisible: boolean } = {
    preventScroll: true,
    focusVisible: true,
  };
  element.focus(options);
}

/**
 * Makes keyboard focus visible without treating a pointer click in a text field
 * as keyboard navigation. Browsers intentionally match :focus-visible for text
 * inputs even after a click, so this app-level modality fact gates the visual
 * treatment consistently for every control.
 */
export function useKeyboardFocusVisibility() {
  useEffect(() => {
    const root = document.documentElement;
    const useKeyboardNavigation = (event: KeyboardEvent) => {
      // Motion follows every keyboard action; focus styling keeps its narrower policy.
      root.dataset.keyboardInput = "";
      if (
        KEYBOARD_NAVIGATION_KEYS.has(event.key) &&
        !event.metaKey &&
        // Alt+Tab and Ctrl+Tab move focus between windows and tabs.
        (!event.ctrlKey || event.key === "Tab") &&
        (!event.altKey || event.key === "Tab")
      ) {
        showKeyboardFocus();
      }
    };
    const usePointerNavigation = () => {
      delete root.dataset.keyboardNavigation;
      delete root.dataset.keyboardInput;
    };

    window.addEventListener("keydown", useKeyboardNavigation, true);
    window.addEventListener("pointerdown", usePointerNavigation, true);
    window.addEventListener("touchstart", usePointerNavigation, true);
    return () => {
      window.removeEventListener("keydown", useKeyboardNavigation, true);
      window.removeEventListener("pointerdown", usePointerNavigation, true);
      window.removeEventListener("touchstart", usePointerNavigation, true);
      delete root.dataset.keyboardNavigation;
      delete root.dataset.keyboardInput;
    };
  }, []);
}
