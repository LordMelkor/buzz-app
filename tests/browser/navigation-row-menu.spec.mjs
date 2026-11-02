import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });
test("channel context menus retain keyboard focus without write capabilities", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = page.locator('[data-channel-id="beta"]');
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  await beta.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: "Channel actions unavailable on this connection",
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
});

// Representative app-wiring regression: a decoded preference update unmounts an
// open Base UI portal while ChannelsPage stays mounted. Transition permutations
// belong in useChannelRowMenu.test.tsx; this checks the actual page/portal seam.
test.describe("menu placement lifetime", () => {
  test.use({ productionBroker: true, savedSidebar: true });
  test("does not resurrect a menu after a preference refresh moves its row away and back", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    });
    const work = sidebar
      .locator("[data-sidebar-section]")
      .filter({ has: page.locator("summary", { hasText: /^Work$/ }) });
    const starred = sidebar
      .locator("[data-sidebar-section]")
      .filter({ has: page.locator("summary", { hasText: /Starred$/ }) });
    const beta = sidebar.locator('[data-channel-id="beta"]');
    const menu = page.getByRole("menu", { name: "Actions for Beta" });
    await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
    await openChannelDetails(page);
    await page.getByText("Diagnostics", { exact: true }).click();
    const refresh = page.getByRole("button", {
      name: "Refresh groups and stars",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    let stars = ["alpha", "beta"];
    // Fake only the host decode response. No app hook or client state injection;
    // no account writes. The existing refresh/store subscription drives the UI.
    await page.route("**/sidebar-preferences", async (route) => {
      requested();
      await held;
      await route.fulfill({
        json: {
          sections: [{ id: "work", name: "Work", order: 0 }],
          assignments: { beta: "work" },
          starred: stars,
          muted: [],
        },
      });
    });
    try {
      await refresh.click();
      await started;
      await expect(refresh).toBeDisabled();
      await beta.click({ button: "right" });
      await expect(menu).toBeVisible();
      release();
      await expect(starred.locator('[data-channel-id="beta"]')).toBeVisible();
      await expect(menu).toHaveCount(0);
      stars = ["alpha"];
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
      await expect(menu).toHaveCount(0);
      await beta.focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(beta).toBeFocused();
    } finally {
      release();
      await page.unroute("**/sidebar-preferences");
    }
  });
});
