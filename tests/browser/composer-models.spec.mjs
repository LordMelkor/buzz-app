import { test, expect } from "./source-fixture.mjs";

// Browser-only: the real portal, Base UI focus handling and CSS Modules.
// The composer unit tests own model discovery and sending the chosen effort.
test("effort picker opens, follows the keyboard and returns focus", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await trigger.click();
  const slider = page.getByRole("slider", {
    name: "Effort for Honey's next run",
  });
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await page.getByRole("dialog").screenshot({
    path: testInfo.outputPath("effort.png"),
  });
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
