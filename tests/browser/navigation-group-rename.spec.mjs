import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({ productionBroker: true, savedSidebar: true, sidebarIcons: true });

// The fixture groups use custom-emoji icons; serve every one as a plain image.
test.beforeEach(({ page }) =>
  page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  ),
);

test("renaming a saved group from its menu persists and keeps its channels", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const work = page.locator('[data-sidebar-section="group:work"]');
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();

  await page.getByRole("button", { name: "More actions for Work" }).click();
  await page.getByRole("menuitem", { name: "Rename section" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename section" });
  const input = dialog.getByRole("textbox", { name: "Section name" });
  await expect(input).toHaveValue("Work");
  await input.fill("Projects");
  await dialog.getByRole("button", { name: "Rename" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(work.locator("summary")).toHaveAccessibleName("Projects");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications.at(-1);
  expect(blob.meta.s.work.name[2]).toBe("Projects");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.reload();
  await openPage(page, "Messages");
  await expect(work.locator("summary")).toHaveAccessibleName("Projects");
});
