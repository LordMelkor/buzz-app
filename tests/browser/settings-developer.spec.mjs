import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  chooseColorMode,
  openSettings,
  selectSettingsSection,
  settingsSections,
} from "./navigation.mjs";

test.use({
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 0 },
});

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("Developer opens through App routing and restores from history", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/stats", (route) =>
    route.fulfill({ json: { queries: 0, errors: 0, media: 0, connects: 0 } }),
  );
  await open(page, app);
  await openSettings(page);
  const sections = settingsSections(page);
  const profile = sections.getByRole("button", {
    name: "Profile",
    exact: true,
  });
  const developer = sections.getByRole("button", {
    name: "Developer",
    exact: true,
  });
  await developer.click();
  await expect(developer).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(developer).toHaveAttribute("aria-current", "page");
  // The shell's Go back control is inert behind the modal; traverse history directly.
  await page.goBack();
  await expect(profile).toHaveAttribute("aria-current", "page");
});

test.describe("client performance", () => {
  test.use({ historyCounts: { alpha: 1, beta: 1 } });
  test("records channel opens by source and exports them", async ({
    page,
    app,
  }, info) => {
    await page.route("**/api/relay/stats", (route) =>
      route.fulfill({ json: { queries: 0, errors: 0, media: 0, connects: 0 } }),
    );
    // Hold Beta's head read so its open deterministically waits on the network.
    const beta = Promise.withResolvers();
    await page.route("**/query", async (route) => {
      const filters = route.request().postDataJSON() ?? [];
      if (filters.some((filter) => filter["#h"]?.includes("beta")))
        await beta.promise;
      await route.fallback();
    });
    await open(page, app);
    try {
      await page.locator('[data-channel-id="beta"]').focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("status").filter({ hasText: "Loading messages…" }),
      ).toBeVisible();
    } finally {
      beta.resolve();
    }
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await page.locator('[data-channel-id="alpha"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Developer", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Client performance", exact: true }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await button(page, "Export JSON").click();
    const exported = JSON.parse(
      await readFile(await (await download).path(), "utf8"),
    );
    const [betaOpen, alphaOpen] = exported.opens.slice(-2);
    // Beta's held read is waiting, not rendering; Alpha's rows were in memory.
    expect(betaOpen.waitMs).toBeGreaterThan(0);
    expect(betaOpen.waitMs).toBeLessThan(betaOpen.ms);
    expect(alphaOpen.waitMs).toBeLessThan(betaOpen.waitMs);
    await expect(page.getByText(/^Server \d+$/)).toBeVisible();
    expect(exported.opens.slice(-2)).toEqual([
      expect.objectContaining({
        channel: "beta",
        trigger: "keyboard",
        source: "network",
      }),
      expect.objectContaining({
        channel: "alpha",
        trigger: "click",
        source: "memory",
      }),
    ]);
    expect(exported.queries.length).toBeGreaterThan(0);

    // Browser geometry proves the dashboard's cards, chart and controls remain
    // reachable; recorder semantics are covered by client-metrics unit tests.
    const checkLayout = async () => {
      const region = page.getByRole("region", {
        name: "Developer",
        exact: true,
      });
      await expect
        .poll(() =>
          region.evaluate((root) => {
            const bounds = root.getBoundingClientRect();
            return [...root.querySelectorAll("button, input, h3, h4, dd")]
              .filter(
                (node) =>
                  node.checkVisibility() &&
                  !node.closest('[aria-hidden="true"]'),
              )
              .filter((node) => {
                const box = node.getBoundingClientRect();
                return box.left < bounds.left || box.right > bounds.right;
              })
              .map((node) => ({
                element: node.outerHTML,
                left: node.getBoundingClientRect().left,
                right: node.getBoundingClientRect().right,
                bounds: [bounds.left, bounds.right],
              }));
          }),
        )
        .toEqual([]);
    };
    for (const mode of ["Light", "Dark"]) {
      await selectSettingsSection(page, "Appearance");
      await chooseColorMode(page, mode);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await selectSettingsSection(page, "Developer");
        await checkLayout();
        await page.screenshot({
          path: info.outputPath(`developer-${mode}-${width}.png`),
        });
      }
    }
    await selectSettingsSection(page, "Appearance");
    for (let step = 0; step < 10; step++)
      await button(page, "Increase interface size").click();
    await selectSettingsSection(page, "Developer");
    await checkLayout();
    await page.evaluate(() => (document.documentElement.dir = "rtl"));
    await checkLayout();
    await page.screenshot({
      path: info.outputPath("developer-390-200-rtl.png"),
    });
    await page.evaluate(() => (document.documentElement.dir = "ltr"));
  });
});
