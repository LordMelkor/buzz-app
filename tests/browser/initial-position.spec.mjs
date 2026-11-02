import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { wheel, open, settle, anchor, expectAnchor } from "./timeline.mjs";

test.use({
  productionBroker: true,
  developmentReact: true,
});
const sized = test.extend({ historyCounts: { alpha: 20, beta: 20 } });
const short = test.extend({ historyCounts: { alpha: 20, beta: 1 } });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
async function bottom(page, app, label) {
  // Quiet geometry can precede Virtua's deferred initial positioning. Observe
  // that positioning first, then verify it remains settled without user input.
  await expect
    .poll(
      () =>
        history(page).evaluate(
          (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
        ),
      { message: label },
    )
    .toBeLessThan(4);
  await settle(page);
  const metrics = await history(page).evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
    viewport: e.clientHeight,
    gap: e.scrollHeight - e.clientHeight - e.scrollTop,
  }));
  app.report.measurements.push({
    label,
    ...metrics,
    saved: await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) =>
          key.startsWith("buzz-view.v1:"),
        ),
      ),
    ),
  });
  expect(metrics.gap, label).toBeLessThan(4);
}
async function select(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: `Message #${name}`, exact: true }),
  ).toBeVisible();
  await expect(
    history(page).locator("[data-message-id]").first(),
  ).toBeVisible();
}

sized(
  "cold and warm sidebar entries start at bottom without scrolling",
  async ({ page, app }) => {
    await open(page, app);
    await bottom(page, app, "cold Alpha");
    await select(page, "Beta");
    await bottom(page, app, "cold Beta");
    await select(page, "Alpha");
    await bottom(page, app, "warm Alpha");
    await openPage(page, "Workflows");
    await page.reload();
    await openPage(page, "Messages");
    await bottom(page, app, "persisted bottom Alpha");
    await select(page, "Beta");
    await bottom(page, app, "persisted bottom Beta");
  },
);

short(
  "short channel with tall messages opens at the actual bottom",
  async ({ page, app }) => {
    expect(app.histories.get("primary/beta")).toHaveLength(1);
    app.append("primary", "beta", "Tall message\n".repeat(70), false);
    app.append("primary", "beta", "Last message\n".repeat(25), false);
    await open(page, app);
    await bottom(page, app, "cold Alpha control");
    await select(page, "Beta");
    await bottom(page, app, "cold tall Beta");
    await select(page, "Alpha");
    await select(page, "Beta");
    await bottom(page, app, "warm tall Beta");
  },
);

// This case tests reading restoration, not cancellation of held older pages.
// Taller rows keep its gesture outside prefetch; paging has separate journeys.
const readingTest = test.extend({
  tallMessages: true,
  historyCounts: { alpha: 20, beta: 1 },
});
readingTest(
  "deliberate reading anchor survives a session reload",
  async ({ page, app }) => {
    await open(page, app);
    await bottom(page, app, "initial bottom");
    await history(page).hover();
    await wheel(page, -650);
    await expect
      .poll(() =>
        history(page).evaluate(
          (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
        ),
      )
      .toBeGreaterThan(400);
    await settle(page);
    expect(
      await history(page).evaluate(
        (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
      ),
      "reading gesture stays outside older-page prefetch",
    ).toBeGreaterThan(0);
    expect(app.pending).toHaveLength(0);
    const reading = await anchor(page);
    await openPage(page, "Workflows");
    await page.reload();
    await openPage(page, "Messages");
    await settle(page);
    await expectAnchor(page, reading);
  },
);

for (const count of [1, 3, 5, 7, 9]) {
  const nearFitTest = test.extend({
    historyCounts: { alpha: 1, beta: count },
  });
  nearFitTest(
    `near-fit channel with ${count} mixed-height rows starts at bottom`,
    async ({ page, app }) => {
      await open(page, app);
      expect(app.histories.get("primary/beta")).toHaveLength(count);
      await select(page, "Beta");
      await bottom(page, app, `cold ${count}-row Beta`);
      await select(page, "Alpha");
      await select(page, "Beta");
      await bottom(page, app, `warm ${count}-row Beta`);
    },
  );
}
