import { pluginAction } from "./plugin-settings.mjs";
import { closeSettings, openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({ historyCounts: { alpha: 1, beta: 0 } });
test("web hides the unusable terminal and does not consume its shortcut, including re-enable", async ({
  page,
  app,
}) => {
  await open(page, app);
  const modifier = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  ))
    ? "Meta"
    : "Control";
  const launcher = button(page, "Toggle channel terminal");
  const drawer = page.getByRole("region", { name: "Terminal drawer" });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep this draft");
  await expect(launcher).toHaveCount(0);
  await page.evaluate(() => {
    window.terminalChordPrevented = null;
    window.addEventListener("keydown", (event) => {
      if (event.key === "j")
        window.terminalChordPrevented = event.defaultPrevented;
    });
  });
  await page.keyboard.press(`${modifier}+j`);
  expect(await page.evaluate(() => window.terminalChordPrevented)).toBe(false);
  await expect(drawer).toHaveCount(0);
  await expect(composer).toHaveJSProperty("value", "Keep this draft");
  await button(page, "Beta").click();
  await expect(launcher).toHaveCount(0);
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Manage plugins").click();
  const toggle = pluginAction(page, "Terminal");
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/^Enable /);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await openPage(page, "Messages");
  await expect(launcher).toHaveCount(0);
  await page.keyboard.press(`${modifier}+j`);
  await expect(drawer).toHaveCount(0);
});
