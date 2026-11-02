import { test, expect } from "./source-fixture.mjs";

// Real browser computed styles and pointer/focus behavior.
test("files message presentation", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?accent=blue");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    const file = page.getByRole("button", {
      name: "Download review-notes.txt",
      exact: true,
    });
    await expect(file.locator('[data-kind="text"]')).toBeVisible();
    await expect(
      page.locator('[data-message-id="file-unavailable"] [data-kind="pdf"]'),
    ).toBeVisible();
  }
});
