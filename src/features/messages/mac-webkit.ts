/** WebKit on any platform: Safari, WKWebView and WebKitGTK. */
export const webKit = () => navigator.vendor === "Apple Computer, Inc.";

/** Desktop Mac WebKit: Safari and Tauri's WKWebView. Desktop-mode iPad also
 * reports MacIntel, but keeps its touch policies. */
export const macWebKit = () =>
  navigator.platform === "MacIntel" && !navigator.maxTouchPoints && webKit();
