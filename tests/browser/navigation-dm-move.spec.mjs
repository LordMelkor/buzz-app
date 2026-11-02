import { expect, test } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  savedSidebar: true,
  dmLabels: true,
  dmMembers: { "dm-move": [0] },
  historyCounts: { alpha: 1, beta: 1 },
  viewport: { width: 1280, height: 720 },
  video: "on",
});

// The browser boundary here is real menu focus/portal interaction plus signed,
// encrypted sidebar preference persistence across a full page reload. Component
// tests cover the placement state transitions without app startup.
test("Move conversation saves a DM in a section and restores it there after reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const directMessages = page.locator(
    '[data-sidebar-section="dms"] [data-channel-id="dm-move"]',
  );
  const work = page.locator(
    '[data-sidebar-section="group:work"] [data-channel-id="dm-move"]',
  );
  await expect(directMessages).toBeVisible();

  await directMessages.click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "Actions for Alice Fixture" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dm-move-row-menu.png"),
  });
  const move = page.getByRole("menuitem", {
    name: "Move conversation",
    exact: true,
  });
  await move.focus();
  await page.keyboard.press("ArrowRight");
  const destinations = page.getByRole("menu", {
    name: "Move Alice Fixture to section",
    exact: true,
  });
  await expect(destinations).toBeVisible();
  await expect(
    destinations.getByRole("menuitemradio", {
      name: "Direct messages",
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("dm-move-menu.png") });

  const starSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/sidebar-star"),
  );
  const assignmentSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/sidebar-assignment"),
  );
  await destinations
    .getByRole("menuitemradio", { name: "Work", exact: true })
    .click();
  expect((await starSaved).ok()).toBe(true);
  expect((await assignmentSaved).ok()).toBe(true);
  await expect(work).toBeVisible();
  await expect(directMessages).toHaveCount(0);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  expect(
    app.report.sidebarPublications.find(
      ({ coordinate }) => coordinate === "channel-sections",
    ).blob.assignments,
  ).toEqual({ beta: "work", "dm-move": "work" });

  await page.reload();
  await expect(work).toBeVisible();
  await expect(directMessages).toHaveCount(0);

  await work.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move conversation" }).focus();
  await page.keyboard.press("ArrowRight");
  const returnDestinations = page.getByRole("menu", {
    name: "Move Alice Fixture to section",
    exact: true,
  });
  await expect(returnDestinations).toBeVisible();
  const returnStarSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/sidebar-star"),
  );
  const returnAssignmentSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/sidebar-assignment"),
  );
  await returnDestinations
    .getByRole("menuitemradio", { name: "Direct messages", exact: true })
    .click();
  expect((await returnStarSaved).ok()).toBe(true);
  expect((await returnAssignmentSaved).ok()).toBe(true);
  await expect(directMessages).toBeFocused();
  await expect(work).toHaveCount(0);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  expect(app.report.sidebarPublications.at(-1).blob.assignments).toEqual({
    beta: "work",
  });

  await page.reload();
  await expect(directMessages).toBeVisible();
  await expect(work).toHaveCount(0);
});
