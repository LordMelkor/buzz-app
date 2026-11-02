import { pluginAction } from "./plugin-settings.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });

test("Local Settings retain plugin recovery without blocking Profile and Appearance", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzzodz.plugins.v1", "{"),
  );
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await button(page, "Appearance").click();
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await button(page, "Manage plugins").click();
  await expect(button(page, "Try again")).toBeVisible({ timeout: 1500 });
  await expect(button(page, "Back up & reset settings")).toBeVisible();
  await button(page, "Back up & reset settings").click();
  await expect(pluginAction(page, "Workflows")).toBeVisible();
});

test.describe("page render failure", () => {
  test.use({ expectedPageFailure: true });
  test("a late failure can be retried within the same visit", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Retry fixture");
    await expect(button(page, "Break fixture page")).toBeVisible();
    const status = () =>
      page.evaluate(() => window.fixtureNavigation.snapshot().status);
    await expect.poll(status).toBe("opened");
    const entry = await page.evaluate(
      () => window.fixtureNavigation.snapshot().entry.id,
    );
    await button(page, "Break fixture page").click();
    await expect(
      page.getByRole("heading", {
        name: "This page couldn’t open",
        exact: true,
      }),
    ).toBeVisible();
    await openPage(page, "Retry fixture");
    await expect(button(page, "Break fixture page")).toBeVisible({
      timeout: 1500,
    });
    await expect.poll(status).toBe("opened");
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
    ).toBe(entry);
    expect(
      app.report.consoleErrors.some((message) =>
        message.includes("Fixture page render failure"),
      ),
    ).toBe(true);
  });
  test("an initial render failure never acknowledges opened", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await page.evaluate(() => {
      window.fixturePageBroken = true;
    });
    await openPage(page, "Retry fixture");
    await expect(
      page.getByRole("heading", {
        name: "This page isn’t available",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().status),
    ).toBe("failed");
    await page.evaluate(() => {
      window.fixturePageBroken = false;
    });
    await button(page, "Try again").click();
    await expect(button(page, "Break fixture page")).toBeVisible();
  });
});

test("a healthy same-page reclick preserves its draft and visit identity", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Legacy");
  const draft = page.getByRole("textbox", {
    name: "Legacy page draft",
    exact: true,
  });
  await draft.fill("retain on reclick");
  const entry = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  await openPage(page, "Legacy");
  await expect(draft).toHaveValue("retain on reclick");
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
  ).toBe(entry);
});
