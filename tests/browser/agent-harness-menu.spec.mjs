import { test, expect } from "./source-fixture.mjs";

// WebKit leaves menu-root focus after pointer entry on an unavailable choice;
// jsdom cannot reproduce that focus path or the resulting nested dismissal.
for (const source of ["local", "hosted"]) {
  test(`${source} harness help consumes Escape before its menu after pointer entry`, async ({
    page,
    browserName,
  }) => {
    await page.goto(`/tests/fixtures/agent-library.html?harness=${source}`);
    await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
    const trigger = page.getByRole("button", { name: /^Change harness/ });
    await trigger.click();
    const menu = page.getByRole("menu");
    const choice = menu.getByRole("menuitemradio", {
      name: source === "local" ? "Builderlab" : "Fixture",
      exact: true,
    });
    await expect(choice).toHaveAttribute("aria-disabled", "true");
    await choice.hover();
    const help = page.getByRole("dialog", { name: "Harness availability" });
    await expect(help).toBeVisible();
    if (browserName === "webkit") await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
