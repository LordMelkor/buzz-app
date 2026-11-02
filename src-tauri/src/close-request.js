// Evaluated only in the trusted main webview by the macOS Close Tab/Close All Tabs menus.
// Native code binds `tabEvent` to the requested close action.
// The status is informational: the window never closes when unhandled.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]'))
    return "handled";
  const target =
    typeof browserSessionId === "string"
      ? document.querySelector(
          `[data-browser-session="${CSS.escape(browserSessionId)}"]`,
        )
      : window;
  if (!target) return "unhandled";
  const request = new Event(tabEvent, { cancelable: true, bubbles: true });
  target.dispatchEvent(request);
  return request.defaultPrevented ? "handled" : "unhandled";
})();
