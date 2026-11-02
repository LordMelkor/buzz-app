// Evaluated only in the trusted main webview by the macOS Show Next/Previous
// Tab menu items. Native code binds `tabEvent` to the event name to dispatch.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
  const target =
    typeof browserSessionId === "string"
      ? document.querySelector(
          `[data-browser-session="${CSS.escape(browserSessionId)}"]`,
        )
      : window;
  if (!target) return;
  // No main-document keydown precedes a request from the browser panel, so
  // record the keyboard modality useKeyboardFocusVisibility would have set.
  document.documentElement.dataset.keyboardNavigation = "";
  target.dispatchEvent(
    new Event(tabEvent, { cancelable: true, bubbles: true }),
  );
})();
