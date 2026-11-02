// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too. Outside a
// browser, as in Node tests, there is no hostname to check.
export const developerMode =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
