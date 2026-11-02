import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

const LONG = "confidential-architecture-and-production-release-planning";

let server;
let directory;
let url;

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-conversation-name-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/conversation-name.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/conversation-name.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout: a long channel name truncates inside its Activity row while the
// visibility icon beside it keeps its full size; jsdom cannot measure either.
test("a long channel name truncates beside a full-size icon in Activity", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  for (const width of [520, 320]) {
    await page.goto(`${url}?width=${width}`);
    const name = page.getByTitle(`${LONG} · channel`);
    await expect(name).toBeVisible();
    const geometry = await name.evaluate((element) => {
      const row = element.closest("li").getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const icon = element.querySelector("svg").getBoundingClientRect();
      const text = element.querySelector("span");
      return {
        icon: [icon.width, icon.height],
        truncated: text.scrollWidth > text.clientWidth,
        inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
      };
    });
    expect(geometry, `at ${width}px`).toEqual({
      icon: [16, 16],
      truncated: true,
      inside: true,
    });
  }
  expect(errors.unexplained()).toEqual([]);
});
