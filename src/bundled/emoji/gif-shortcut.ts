/** One plugin shortcut routes to one live composer, including split-pane chats. */
export function createGifShortcut() {
  const pickers = new Map<HTMLElement, () => void>();
  const target = () => {
    const visible = [...pickers.keys()].filter(
      (element) =>
        element.isConnected &&
        !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
        (element.checkVisibility?.({ visibilityProperty: true }) ?? true),
    );
    // Prefer the focused conversation/pane; otherwise the newest visible composer
    // (for example a newly opened thread) owns the action.
    for (
      let element = document.activeElement;
      element;
      element = element.parentElement
    ) {
      const contained = visible.filter((picker) => element.contains(picker));
      if (contained.length === 1) return contained[0];
    }
    return visible.at(-1);
  };
  return {
    register(element: HTMLElement, open: () => void) {
      pickers.set(element, open);
      return () => {
        if (pickers.get(element) === open) pickers.delete(element);
      };
    },
    available: () => !!target(),
    run() {
      const element = target();
      if (element) pickers.get(element)?.();
    },
  };
}
export type GifShortcut = ReturnType<typeof createGifShortcut>;
