import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

// Linux WebKit is built without MediaRecorder. Those cases run with the local
// config in the required macOS job; Chromium still records on Linux.
// The documented @local-webkit measurements remain local-only.
export default defineConfig({
  ...config,
  projects: config.projects.map((project) =>
    project.name === "webkit-measurements"
      ? { ...project, grepInvert: /@local-webkit/ }
      : project.name === "webkit"
        ? {
            ...project,
            grepInvert: /@classic-scrollbars|@media-recorder|@local-only/,
          }
        : project.name === "chromium"
          ? { ...project, grepInvert: /@classic-scrollbars|@local-only/ }
          : project,
  ),
});
