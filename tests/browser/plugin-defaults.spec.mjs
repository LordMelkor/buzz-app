import { pluginAction } from "./plugin-settings.mjs";
import { openCommunityPicker } from "./navigation.mjs";
import {
  closeSettings,
  openSettings,
  openPage,
  selectSettingsSection,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function plugins(page) {
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
}

// Representative app wiring: real catalogs -> Settings actions -> sidebar page,
// across reload. Choice permutations live in storage unit tests.
test("Bestie opts in without changing the other bundled defaults and survives reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(button(page, "Bestie")).toHaveCount(0);
  await plugins(page);
  const bestie = pluginAction(page, "Bestie");
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  for (const name of [
    "GitHub",
    "Terminal",
    "Workflows",
    "Builderlab",
    "Attention",
  ])
    await expect(pluginAction(page, name)).toHaveAccessibleName(/^Disable /);
  await bestie.click();
  await expect(bestie).toHaveAccessibleName(/^Disable /);
  await page.reload();
  await expect(bestie).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await openPage(page, "Messages");
  await expect(
    page
      .locator(".shell-header")
      .getByRole("button", { name: "Bestie", exact: true }),
  ).toHaveCount(0);
  const destination = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Bestie", exact: true });
  await expect(destination).toBeVisible();
  await destination.click();
  await expect(
    page.getByRole("heading", { name: "Meet your Bestie" }),
  ).toBeVisible();
  await plugins(page);
  await bestie.click();
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  await page.reload();
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  // The workspace behind Settings is hidden from the accessibility tree.
  await closeSettings(page);
  await expect(button(page, "Bestie")).toHaveCount(0);
});

// Real App -> shell -> rail Settings-registry wiring, including the scoped
// destination. Role and contribution-removal permutations stay in jsdom.
test("Membership action removes and restores the working Invite destination", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.every((filter) => filter.kinds?.includes(13534)))
      return route.fulfill({ json: [app.membershipSnapshot("owner")] });
    return route.continue();
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const invite = page.getByRole("menuitem", {
    name: "Invite to community",
    exact: true,
  });
  const menu = async () => {
    await openCommunityPicker(page);
    await button(page, "Switch to Primary").click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: "Actions for Primary" }),
    ).toBeVisible();
  };
  await plugins(page);
  const admin = pluginAction(page, "Membership");
  await expect(admin).toHaveAccessibleName(/^Disable /);
  const moderation = pluginAction(page, "Moderation");
  await expect(moderation).toHaveAccessibleName("Disable Moderation");
  await expect(moderation).toHaveAccessibleDescription(
    "Access is unavailable in this build or on this relay.",
  );
  await expect(moderation).not.toHaveAttribute("aria-disabled", "true");
  await moderation.click();
  await expect(moderation).toHaveAccessibleName("Unavailable Moderation");
  await page.reload();
  await expect(moderation).toHaveAccessibleName("Unavailable Moderation");
  await expect(admin).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await menu();
  await expect(invite).toBeVisible();
  await page.keyboard.press("Escape");
  await plugins(page);
  await admin.click();
  await expect(admin).toHaveAccessibleName(/^Enable /);
  await closeSettings(page);
  await menu();
  await expect(invite).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Leave community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await plugins(page);
  await admin.click();
  await expect(admin).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await menu();
  await invite.click();
  await expect(
    page.getByRole("heading", { name: "Membership", exact: true }),
  ).toBeVisible();
});
