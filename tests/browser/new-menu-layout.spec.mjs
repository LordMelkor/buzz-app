import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

// Browser hit testing is required: jsdom cannot detect overflowing filter text.
test("New remains clickable beside enlarged navigation filters", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await settleShellToggle(page);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const trigger = page.getByRole("button", { name: "New", exact: true });
  await expect(trigger).toBeInViewport();
  const before = await page
    .getByRole("tablist", { name: "Navigation scope" })
    .getByRole("tab", { selected: true })
    .textContent();
  await trigger.click();
  await expect(
    page.getByRole("menu", { name: "New", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("tablist", { name: "Navigation scope" })
      .getByRole("tab", { selected: true }),
  ).toHaveText(before);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
