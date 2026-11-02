import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-agent-share-card-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/agent-share-card.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/agent-share-card.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout only a browser can show: the card fits whole in the preview, from a
// roomy window down to a short one at enlarged text, and while a wrapping save
// error sits above it. The preview is centred, and no wider than Share.
for (const { width, height, large, failed } of [
  { width: 1280, height: 900, large: false, failed: false },
  { width: 480, height: 640, large: false, failed: false },
  { width: 600, height: 600, large: true, failed: false },
  { width: 600, height: 600, large: true, failed: true },
]) {
  test(`the export card fits whole at ${width}×${height}${large ? " with enlarged text" : ""}${failed ? " after a save fails" : ""}`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height });
    await page.goto(large ? `${url}?large` : url);
    const share = page.getByRole("dialog", { name: "Share Ada" });
    const shareBox = await share
      .locator(".buzz-dialog-step:not([inert])")
      .boundingBox();
    await share
      .getByRole("button", { name: "Export Ada as an agent card" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Export Ada" });
    const card = dialog.getByRole("img", { name: "Ada’s agent card" });
    await expect(card).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Save card" }),
    ).toBeEnabled();
    if (failed) {
      // The card's own link is made; the saved file's then can't be.
      await page.evaluate(() => {
        URL.createObjectURL = () => {
          throw new Error(
            "The browser refused to make a download link for this card, so nothing was saved.",
          );
        };
      });
      await dialog.getByRole("button", { name: "Save card" }).click();
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText("Couldn’t export Ada.");
      // Enlarged text wraps it past the one row reserved for feedback.
      expect((await alert.boundingBox()).height).toBeGreaterThan(60);
    }
    const step = dialog.locator(".buzz-dialog-step:not([inert])");
    // Wait out the step crossfade before measuring.
    await expect(step).not.toHaveAttribute("data-starting-style");
    await expect(step).not.toHaveAttribute("data-ending-style");
    await expect(dialog.locator(".buzz-dialog-step")).toHaveCount(1);
    const geometry = await step.evaluate((element) => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      };
      const body = element.querySelector(".buzz-dialog-body");
      const image = element.querySelector("img");
      return {
        step: box(element),
        stepScrolls: element.scrollHeight - element.clientHeight,
        body: box(body),
        bodyScrolls: body.scrollHeight - body.clientHeight,
        card: box(image),
        save: box(element.querySelector(".buzz-dialog-actions")),
      };
    });
    expect(geometry.stepScrolls, "the step doesn't scroll").toBeLessThanOrEqual(
      0,
    );
    expect(geometry.bodyScrolls, "the body doesn't scroll").toBeLessThanOrEqual(
      0,
    );
    // Whole, inside the body and above the actions.
    expect(geometry.card.top).toBeGreaterThanOrEqual(geometry.body.top - 0.5);
    expect(geometry.card.bottom).toBeLessThanOrEqual(
      geometry.body.bottom + 0.5,
    );
    expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.body.left - 0.5);
    expect(geometry.card.right).toBeLessThanOrEqual(geometry.body.right + 0.5);
    expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.save.top);
    expect(geometry.step.bottom).toBeLessThanOrEqual(height);
    // Still a card, not a sliver.
    expect(geometry.card.bottom - geometry.card.top).toBeGreaterThan(100);
    // Centred in the window, and no wider than Share.
    expect(
      Math.abs(geometry.step.top - (height - geometry.step.bottom)),
    ).toBeLessThanOrEqual(1);
    expect(geometry.step.right - geometry.step.left).toBeLessThanOrEqual(
      shareBox.width,
    );
    expect(errors).toEqual([]);
  });
}
