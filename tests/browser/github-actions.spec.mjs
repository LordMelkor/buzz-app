import { test, expect } from "./source-fixture.mjs";

// jsdom cannot detect a trigger moving out from under the pointer between
// mouse-down and mouse-up, which dismisses the menu before an action is chosen.
test("PR action menu converts a pull request to draft after a pointer click", async ({
  page,
}) => {
  for (const state of ["", "?ready"]) {
    for (const [width, scale] of [
      [1000, 1],
      [480, 2],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"]) {
        await page.goto(`/tests/fixtures/github-actions.html${state}`);
        await page.evaluate(
          ({ theme, scale }) => {
            document.documentElement.dataset.colorMode = theme;
            document.documentElement.style.fontSize = `${16 * scale}px`;
          },
          { theme, scale },
        );
        const trigger = page.getByRole("button", {
          name: "More pull request actions",
        });
        const item = page.getByRole("menuitem", { name: "Convert to draft" });
        await expect(trigger).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await trigger.hover();
        await page.mouse.down();
        try {
          // A real press can render the opened menu before release. An instant
          // locator.click() can send both events before that render and hide the bug.
          await expect(item).toBeVisible();
        } finally {
          await page.mouse.up();
        }
        await item.click();
        await expect(page.getByText("Draft", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Ready for review", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
    }
  }
});
