import { closeSettings, openSettings } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true, enabledPlugins: ["fixture.notices"] });

test("a plugin's notice shows on any page and takes the owner's answer over Settings", async ({
  page,
  app,
}) => {
  await open(page, app);
  const ask = page.getByRole("dialog", { name: "Let Fixture delete a.txt?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("From Notice fixture");
  await openSettings(page);
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Allow once" }).click();
  await expect(ask).toHaveCount(0);
  const answered = page.getByRole("dialog", { name: "Answered once" });
  await expect(answered).toBeVisible();
  await closeSettings(page);
  await expect(answered).toBeVisible();
});
