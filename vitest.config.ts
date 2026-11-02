import { configDefaults, defineConfig } from "vitest/config";
import { fixtureAliases } from "./tests/relay-config.ts";
const workerLimit = process.env.BUZZ_TEST_WORKERS;
const maxWorkers = workerLimit === undefined ? undefined : Number(workerLimit);
if (
  maxWorkers !== undefined &&
  (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)
) {
  throw new Error("BUZZ_TEST_WORKERS must be a positive integer");
}
// The app formats dates and lists in the host's default locale, and tests
// assert en-US text. Workers read that default from the environment once, at
// startup, so pin it before they fork. C.UTF-8 resolves to en-US like CI's.
process.env.LC_ALL = "C.UTF-8";

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
      JSON.stringify(fixtureAliases),
  },
  test: {
    maxWorkers,
    include: [
      "src/**/*.test.{ts,tsx,mjs}",
      "browser-host/**/*.test.mjs",
      "scripts/**/*.test.{ts,mjs}",
      "tests/browser/perf/**/*.test.mjs",
      "tests/fixtures/design-system/**/*.test.{ts,tsx}",
    ],
    // flake-check.test.mjs writes a suite here with a test that fails if it
    // runs, and opts in for its own runs. A copy that an interrupted run
    // leaves behind stays out of every other run.
    exclude: process.env.BUZZ_FLAKE_CHECK_FIXTURE
      ? configDefaults.exclude
      : [
          ...configDefaults.exclude,
          "tests/fixtures/design-system/flake-selection-*/**",
        ],
  },
});
