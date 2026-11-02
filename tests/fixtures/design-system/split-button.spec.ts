import { expect, test } from "@playwright/test";

test("split buttons keep their joined edges when the menu opens", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/design-system.html#/design/components/split-button",
  );
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    for (const variant of ["subtle", "outline", "prominent"]) {
      const split = page
        .locator(`.buzz-split-button[data-variant="${variant}"]`)
        .first();
      const action = split.getByRole("button", { name: "Import as Claude" });
      const trigger = split.getByRole("button", { name: "Choose agent type" });
      const joined = async () => {
        await expect(action).toHaveCSS("border-start-end-radius", "0px");
        await expect(action).toHaveCSS("border-end-end-radius", "0px");
        await expect(trigger).toHaveCSS("border-start-start-radius", "0px");
        await expect(trigger).toHaveCSS("border-end-start-radius", "0px");
      };
      await joined();
      await trigger.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await joined();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await joined();
      // A wrapped action still shares the complete capsule with its menu.
      await split.evaluate((element) => {
        element.style.maxWidth = "140px";
      });
      const actionBox = await action.boundingBox();
      const triggerBox = await trigger.boundingBox();
      const splitBox = await split.boundingBox();
      expect(actionBox?.height).toBe(triggerBox?.height);
      expect(actionBox?.x).toBeGreaterThanOrEqual(splitBox?.x ?? 0);
      expect(
        (triggerBox?.x ?? 0) + (triggerBox?.width ?? 0),
      ).toBeLessThanOrEqual((splitBox?.x ?? 0) + (splitBox?.width ?? 0) + 1);
    }
  }
});
