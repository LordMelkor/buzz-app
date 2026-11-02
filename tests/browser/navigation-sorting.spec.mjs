import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true, sortingSidebar: true });
// Native details/menu nesting, submenu focus/viewport placement and row reorder
// through the built app + real broker are browser contracts. Matrices live below.
test("section sort applies immediately, rolls back on failure, and persists retry independently", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const channels = sidebar.locator('[data-sidebar-section="channels"]');
  const work = sidebar.locator('[data-sidebar-section="group:work"]');
  const trigger = channels.getByRole("button", {
    name: "More actions for Channels",
  });
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  expect(alphaOrder.length).toBeGreaterThan(2);
  const activity = app.report.queries.filter((q) =>
    q.filter.kinds?.includes(45003),
  );
  expect(activity).toEqual([]);
  async function openSort() {
    await trigger.click();
    await expect(channels.locator("details")).toHaveAttribute("open", "");
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menu", { name: "Sort Channels", exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-alpha.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  await openSort();
  const menu = page.getByRole("menu", { name: "Sort Channels", exact: true });
  await expect(
    menu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-sort", async (route) => {
    started();
    await held;
    app.report.sidebarSortFailures ??= [];
    app.report.sidebarSortFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "sort save failed" }),
    });
  });
  try {
    await menu.getByRole("menuitemradio", { name: "Recent" }).click();
    await requestStarted;
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "A–Z" }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect.poll(order).not.toEqual(alphaOrder);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the sort order for Channels" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect.poll(order).toEqual(alphaOrder);
  await page.unroute("**/sidebar-sort");
  // Error ownership is session-scoped, not coupled to the dismissed menu/page.
  await page.getByRole("tab", { name: "Agents", exact: true }).first().click();
  await expect(sidebar).toBeVisible();
  await expect(error).toBeVisible();
  async function confirmedSort(action) {
    const response = page.waitForResponse("**/sidebar-sort");
    await action();
    expect((await response).ok()).toBe(true);
    await (await response).finished();
  }
  await confirmedSort(() =>
    error.getByRole("button", { name: "Retry sort" }).click(),
  );
  await expect(error).toHaveCount(0);
  await expect.poll(order).not.toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-sort",
    blob: { groups: { channels: "recent" } },
  });
  const recentOrder = await order();
  // The row menu and section sort share one session preference owner. A mute
  // confirmation must not drop Recent, and later sorting must not drop mute.
  const cedar = channels.locator('[data-channel-id="cedar"]');
  await cedar.click({ button: "right" });
  const rowMenu = page.getByRole("menu", { name: "Actions for Cedar" });
  const muted = page.waitForResponse("**/sidebar-mute");
  await rowMenu.getByRole("menuitem", { name: "Mute", exact: true }).click();
  expect((await muted).ok()).toBe(true);
  await (await muted).finished();
  await expect(rowMenu).toHaveCount(0);
  await expect(cedar).toBeFocused();
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await expect(
    menu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  // Real layout verifies that the shared nested-radius recipe reaches both the lone
  // submenu trigger and grouped radio choices, without feature-local corners.
  const sort = page
    .getByRole("menu", { name: "More actions for Channels", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [720, 1000, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const radius = await sort.evaluate((element) => {
        const popup = element.closest(".buzz-menu-popup");
        const style = getComputedStyle(popup);
        return `${Math.max(
          0,
          Number.parseFloat(style.borderTopLeftRadius) -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.borderLeftWidth),
        )}px`;
      });
      for (const item of [
        sort,
        menu.getByRole("menuitemradio", { name: "Recent" }),
        menu.getByRole("menuitemradio", { name: "A–Z" }),
      ]) {
        for (const corner of [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
        ]) {
          await expect(item).toHaveCSS(`border-${corner}-radius`, radius);
        }
      }
    }
  }
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-menu.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  const box = await menu.boundingBox(),
    viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).not.toBeVisible();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const workMenu = page.getByRole("menu", { name: "Sort Work", exact: true });
  await expect(
    workMenu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  await confirmedSort(() =>
    workMenu.getByRole("menuitemradio", { name: "Recent" }).click(),
  );
  await expect(workMenu).not.toBeVisible();
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await confirmedSort(() =>
    menu.getByRole("menuitemradio", { name: "A–Z" }).click(),
  );
  await expect(menu).not.toBeVisible();
  await expect.poll(order).toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    "section:work": "recent",
  });
  await page.reload();
  await expect.poll(order).toEqual(alphaOrder);
  await cedar.click({ button: "right" });
  await expect(
    rowMenu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(cedar).toBeFocused();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    workMenu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(app.report.unexpected).toEqual([]);
});

// The production portal/action wiring and broker retry boundary are browser
// contracts; state-machine ordering remains covered by the session test.
test("retires Recent failures on A–Z and recovers selected ordering on retry", async ({
  page,
  app,
}) => {
  let attempts = 0;
  let releaseFailure;
  let failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/channel-activity", async (route) => {
    attempts++;
    if (attempts <= 3) {
      await failureGate;
      app.report.sidebarActivityFailures ??= [];
      app.report.sidebarActivityFailures.push(route.request().url());
      // A denial: a transient failure would retry quietly first.
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "activity read failed" }),
      });
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await open(page, app);
  const channels = page.locator('[data-sidebar-section="channels"]');
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  const menu = page.getByRole("menu", { name: "Sort Channels", exact: true });
  async function openSort() {
    await channels
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(menu).toBeVisible();
  }
  async function setSort(mode) {
    await openSort();
    const saved = page.waitForResponse("**/sidebar-sort");
    await menu.getByRole("menuitemradio", { name: mode }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    await response.finished();
    await expect(menu).not.toBeVisible();
  }
  const notifications = page.getByRole("region", { name: "App notifications" });
  const warning = notifications.getByText("Couldn’t refresh recent activity");
  async function failRecent(expectedAttempts) {
    failureGate = new Promise((resolve) => {
      releaseFailure = resolve;
    });
    await setSort("Recent");
    await expect.poll(() => attempts).toBe(expectedAttempts);
    // Settle the save before rejecting history, so its publication cannot
    // trigger an incidental retry and conceal the explicit recovery boundary.
    releaseFailure();
    await expect(warning).toBeVisible();
  }
  try {
    await failRecent(1);
    await expect(
      notifications.getByText(
        "Activity filters and Recent sorting may be out of date.",
      ),
    ).toBeVisible();
    await setSort("A–Z");
    await expect(warning).toHaveCount(0);
    await expect.poll(order).toEqual(alphaOrder);

    await failRecent(2);
    await notifications
      .getByRole("button", { name: "Dismiss notification" })
      .click();
    await expect(warning).toHaveCount(0);
    await setSort("A–Z");
    await failRecent(3);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await notifications.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => attempts).toBe(4);
    await expect(warning).toHaveCount(0);
    await expect
      .poll(async () => (await order()).slice(0, 3))
      .toEqual(["willow", "maple", "cedar"]);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(app.report.unexpected).toEqual([]);
  } finally {
    releaseFailure();
  }
});

// Cold-start paint is a composition contract: real saved sort, activity response,
// and independent conversation opening. Timer/order permutations live in RTL.
test.describe("cold sidebar presentation", () => {
  test.use({ initialSidebarSort: { channels: "recent" } });
  test("reveals saved placement and Recent together without blocking the conversation", async ({
    page,
    app,
  }, testInfo) => {
    let releasePreferences, releaseActivity;
    const preferences = new Promise((resolve) => {
      releasePreferences = resolve;
    });
    const activity = new Promise((resolve) => {
      releaseActivity = resolve;
    });
    let preferencesStarted, activityStarted;
    const decoding = new Promise((resolve) => {
      preferencesStarted = resolve;
    });
    const ordering = new Promise((resolve) => {
      activityStarted = resolve;
    });
    // The installed clock ticks from injection, so pausing at runner "now"
    // races its first sync. Pause at a fixed instant from the install base;
    // nothing is pending in about:blank for the jump to fire.
    const base = Date.now();
    await page.clock.install({ time: base });
    await page.clock.pauseAt(base + 20_000);
    await page.addInitScript(() =>
      localStorage.setItem("buzz-appearance.v1", "dark"),
    );
    await page.route("**/sidebar-preferences", async (route) => {
      const response = await route.fetch();
      preferencesStarted();
      await preferences;
      await route.fulfill({ response });
    });
    await page.route("**/channel-activity", async (route) => {
      const response = await route.fetch();
      activityStarted();
      await activity;
      await route.fulfill({ response });
    });
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    try {
      await page.goto(app.origin);
      await decoding;
      // Solo history shares this scrollport and reports its own loading.
      await expect(
        sidebar
          .getByRole("status")
          .filter({ hasText: "Loading your sidebar…" }),
      ).toBeVisible();
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-loading.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
      releasePreferences();
      await ordering;
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      releaseActivity();
      const rows = sidebar.locator(
        '[data-sidebar-section="channels"] [data-channel-id]',
      );
      await expect(rows.first()).toBeVisible();
      expect(
        await rows.evaluateAll((elements) =>
          elements.slice(0, 3).map((el) => el.dataset.channelId),
        ),
      ).toEqual(["willow", "maple", "cedar"]);
      await expect(
        sidebar.locator(
          '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
        ),
      ).toBeVisible();
      await expect(sidebar.getByRole("status")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-revealed.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
    } finally {
      releasePreferences();
      releaseActivity();
      // Remove the gates before resumed timers can start a fresh intercepted read.
      await page.unroute("**/sidebar-preferences");
      await page.unroute("**/channel-activity");
      await page.clock.resume();
    }
  });
});

// Browser integration: confirmed lifecycle removal must use the same sorted
// projection, and reload must compose saved sorting with relay DM visibility.
test.describe("sorting with lifecycle visibility", () => {
  test.use({
    channelLifecycle: true,
    initialSidebarSort: { channels: "recent", dms: "recent" },
  });
  test("archive and DM hide preserve Recent ordering through reload", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const channels = sidebar.locator('[data-sidebar-section="channels"]');
    const ids = () =>
      channels
        .locator("[data-channel-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.channelId));
    const archivedId = "11111111-1111-4111-8111-111111111111";
    const hiddenId = "22222222-2222-4222-8222-222222222222";
    await expect.poll(ids).toEqual(["willow", "maple", "cedar", archivedId]);
    const channel = channels.locator(`[data-channel-id="${archivedId}"]`);
    await channel.click();
    const composer = page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const conversationUrl = page.url();
    await channel.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive channel", exact: true })
      .click();
    const archive = page.getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
    });
    await archive
      .getByRole("button", { name: "Archive channel", exact: true })
      .click();
    await expect(archive).toHaveCount(0);
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    // Archive removes the sidebar row, not the selected conversation.
    await expect(page).toHaveURL(conversationUrl);
    await expect(
      page.getByRole("region", { name: "Archived channel", exact: true }),
    ).toHaveText("This channel is archived");
    await expect(composer).toHaveCount(0);

    const dm = sidebar.locator(`[data-channel-id="${hiddenId}"]`);
    await dm.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Hide conversation", exact: true })
      .click();
    const hide = page.getByRole("dialog");
    await hide
      .getByRole("button", { name: "Hide conversation", exact: true })
      .click();
    await expect(hide).toHaveCount(0);
    await expect(dm).toHaveCount(0);
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    await page.reload();
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    await expect(page).toHaveURL(conversationUrl);
    await expect(
      page.getByRole("region", { name: "Archived channel", exact: true }),
    ).toHaveText("This channel is archived");
    await expect(composer).toHaveCount(0);
    // Opening Sort proves saved preference decoding and sidebar startup settled.
    await channels
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(
        () =>
          app.report.queries.filter(({ filter }) =>
            filter.kinds?.includes(30622),
          ).length,
      )
      .toBeGreaterThan(1);
    await expect(dm).toHaveCount(0);
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9002, 41012],
    );
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
