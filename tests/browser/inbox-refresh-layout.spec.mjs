import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and header truncation cannot be inferred from jsdom. Hold the
// addressed refresh while ordinary unread catch-up completes so only the loading
// indicator (not the separate stale/error notices) can change row geometry.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const width of [1280, 280]) {
  test(`Inbox refresh status preserves layout at ${width}px`, async ({
    page,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const status = inbox.getByText("Checking recent activity…", {
      exact: true,
    });
    const list = inbox.getByRole("list", { name: "Inbox conversations" });
    const rows = list.getByRole("listitem");
    const filters = inbox.getByRole("button", {
      name: "Inbox filters",
      exact: true,
    });
    await expect(rows).toHaveCount(3);
    await expect(status).toHaveCount(0);
    let gate;
    await page.route("**/api/relay/primary/query", async (route) => {
      const pending = gate;
      if (
        !pending ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter["#p"] && filter.kinds?.includes(9))
      )
        return route.continue();
      pending.started = true;
      await pending.promise;
      await route.continue();
    });
    // The list's toolbar, not the page's tab strip above it.
    const toolbar = inbox.locator("header").filter({
      has: page.getByRole("button", { name: "Inbox filters", exact: true }),
    });
    await expect(toolbar).toHaveCount(1);
    const geometry = () =>
      inbox.evaluate((element) => {
        const header = element
          .querySelector('[aria-label="Inbox filters"]')
          .closest("header");
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          rows: [
            ...element.querySelectorAll(
              '[aria-label="Inbox conversations"] > li',
            ),
          ].map((row) => ({ ...box(row), text: row.textContent })),
          header: box(header),
          filters: box(element.querySelector('[aria-label="Inbox filters"]')),
          unread: box(element.querySelector('[aria-label="Unread only"]')),
        };
      });
    const measurements = [];
    await expect(filters).toBeVisible();
    const before = await geometry();
    gate = { ...Promise.withResolvers(), started: false };
    try {
      app.relay.disconnect("primary");
      await expect.poll(() => gate.started).toBe(true);
      await expect(status).toBeVisible();
      await expect(inbox.getByText("Showing retained activity.")).toHaveCount(
        0,
      );
      await expect.poll(geometry).toEqual(before);
      await expect(
        toolbar.getByText("Checking recent activity…"),
      ).toBeVisible();
      const textStyle = await status.evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflow: getComputedStyle(element).overflow,
        textOverflow: getComputedStyle(element).textOverflow,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
      }));
      expect(textStyle).toMatchObject({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      // The pane width that truncated beside the former 48px community rail.
      if (width === 280)
        expect(textStyle.scrollWidth).toBeGreaterThan(textStyle.width);
      const during = await geometry();
      measurements.push({ width, before, during, textStyle });
    } finally {
      gate.resolve();
      gate = undefined;
    }
    await expect(status).toHaveCount(0);
    await expect.poll(geometry).toEqual(before);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(filters).toHaveText("All");
    await filters.click();
    for (const name of ["People", "Agents"]) {
      await expect(
        page.getByRole("menuitemcheckbox", { name, exact: true }),
      ).toBeChecked();
    }
    await page.keyboard.press("Escape");
    await testInfo.attach("refresh-geometry", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}

// Only a browser can prove that the sibling Archive control leaves readable
// label space when the host's interface size doubles at a narrow width.
test("narrow enlarged-text rows overlay Archive without erasing their labels", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(list).toHaveAttribute("aria-busy", "false");
  const row = rows.first();
  const open = row.getByRole("button", { name: /^Open / });
  const archive = row.getByRole("button", { name: /^Archive / });
  const geometry = () =>
    row.evaluate((element) => {
      const open = element.querySelector(".navigation-item");
      const label = open.querySelector(".navigation-item-label");
      const action = open.nextElementSibling;
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        row: box(element),
        open: box(open),
        label: box(label),
        action: box(action),
      };
    });
  const measured = await geometry();
  // NavigationItem truncates long labels at enlarged text sizes; this checks
  // that Archive reserves no additional inline space, not full visual acceptance.
  expect(measured.label.width).toBeGreaterThanOrEqual(2 * measured.root);
  expect(measured.open.x + measured.open.width).toBe(
    measured.row.x + measured.row.width,
  );
  expect(measured.action.y).toBeGreaterThanOrEqual(measured.open.y);
  expect(measured.action.y + measured.action.height).toBeLessThanOrEqual(
    measured.open.y + measured.open.height,
  );
  await open.focus();
  await expect(archive.locator("xpath=..")).toHaveCSS("opacity", "1");
  await expect(row.locator("time")).toHaveCSS("opacity", "0");
  await archive.click();
  await expect(rows).toHaveCount(2);
  await inbox
    .getByRole("button", { name: "Inbox filters", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Archived");
  await expect(page.getByRole("menu", { name: "Inbox filters" })).toHaveCount(
    0,
  );
  await rows.getByRole("button", { name: /^Open / }).focus();
  await rows.getByRole("button", { name: /^Restore / }).click();
  await expect(rows).toHaveCount(0);
  // Row actions never open a conversation tab.
  await expect(
    inbox.getByRole("region", { name: /^Conversation in / }),
  ).toHaveCount(0);
  const filters = inbox.getByRole("button", {
    name: "Inbox filters",
    exact: true,
  });
  await filters.click();
  const menu = page.getByRole("menu", { name: "Inbox filters" });
  await menu.getByRole("menuitemradio", { name: "Inbox", exact: true }).click();
  await filters.click();
  await menu
    .getByRole("menuitemradio", { name: "Mentions", exact: true })
    .click();
  await filters.click();
  await menu
    .getByRole("menuitemcheckbox", { name: "People", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(filters).toHaveText("Mentions · Agents");
  await expect
    .poll(() =>
      filters.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(390);
});
