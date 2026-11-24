import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { clickRow, open, settle } from "./timeline.mjs";

// Browser-only: the inline thread and details are dialogs on the conversation
// visit. Only real history events, layout around a composer and the composer's
// draft storage across a remount prove them. Address parsing and the setting
// are covered by their unit tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const roots = (app) =>
  app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
const viewThread = (page, root) =>
  page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
const threadHeading = (page) =>
  page.getByRole("heading", { name: "Thread", exact: true });
const sheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ has: threadHeading(page) });
// A details sheet holds no thread of its own.
const detailsSheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ hasNot: threadHeading(page) });
const threadTab = (page, root) =>
  page.locator(`[role="tab"][data-tab-value="thread:alpha:${root.id}"]`);
const reply = (scope) =>
  scope.getByRole("textbox", { name: "Reply to thread", exact: true });
const side = (page) => page.locator("[data-panel-workspace]");
const filler = "More of it follows here. ".repeat(30);
/** A peer's details message: in `root`'s thread, or the channel's own. */
const details = (app, text, root) =>
  app.append(
    "primary",
    "alpha",
    `${text}\n\n${filler}`,
    true,
    false,
    root?.id,
    undefined,
    [["audience", "details"]],
  );
const showMore = (scope, text) =>
  scope
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .getByRole("button", { name: "Show more", exact: true });
const close = (scope) =>
  scope.getByRole("button", { name: "Close", exact: true }).first();

test.describe("Side panel", () => {
  test.use({ threadPlacement: "side" });

  test("a thread still opens in its tab", async ({ page, app }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toBeFocused();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("details in a thread tab read over that tab's reply box", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root, other] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    details(app, "Tab findings", root);
    await showMore(side(page), "Tab findings").click();
    const reader = detailsSheet(page);
    await expect(reader).toBeVisible();
    await expect(reader.getByText(filler.trim())).toBeVisible();
    // It is the tab's dialog: drawn inside the side pane, around its composer.
    await expect(
      side(page).locator("[data-details-sheet-surface]"),
    ).toHaveCount(1);
    const [outer, inner] = [
      await reader.boundingBox(),
      await reply(side(page)).locator("xpath=ancestor::form[1]").boundingBox(),
    ];
    expect(outer.x).toBeLessThan(inner.x);
    expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
    await page.goBack();
    await expect(reader).toHaveCount(0);
    await expect(threadTab(page, root)).toBeVisible();
    await page.goForward();
    await expect(detailsSheet(page)).toBeVisible();
    await close(detailsSheet(page)).click();
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(threadTab(page, root)).toBeVisible();
    // The visit now names another thread, and the first tab is chosen
    // again without a visit. Its details still read over it.
    const selected = (tab) =>
      expect(tab).toHaveAttribute("aria-selected", "true");
    await clickRow(page, viewThread(page, other));
    await selected(threadTab(page, other));
    await threadTab(page, root).click();
    await showMore(side(page), "Tab findings").click();
    await expect(detailsSheet(page)).toBeVisible();
    await selected(threadTab(page, root));
    await page.reload();
    await expect(detailsSheet(page)).toBeVisible();
    await selected(threadTab(page, root));
    await expect(threadTab(page, other)).toBeVisible();
  });
});

test.describe("Main pane", () => {
  test.use({ threadPlacement: "main" });

  test("details from a thread tab chosen in a plain visit read over that tab", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    // Back to the plain channel visit, then choose the tab there.
    await page.goBack();
    await threadTab(page, root).click();
    details(app, "Main findings", root);
    const main = page.locator("[data-main-workspace]");
    await showMore(main, "Main findings").click();
    await expect(detailsSheet(page)).toBeVisible();
    await expect(threadTab(page, root)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.reload();
    await expect(detailsSheet(page)).toBeVisible();
    await expect(threadTab(page, root)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test.describe("Inline", () => {
  test.use({ threadPlacement: "inline" });

  test("a thread opens over the composer and follows the dialog contract", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const beta = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="beta"]');
    const alpha = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="alpha"]');
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await alpha.click();
    await settle(page);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await expect(threadTab(page, root)).toHaveCount(0);
    // Back closes the dialog and stays in the channel; Forward reopens it.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await page.goForward();
    await expect(sheet(page)).toBeVisible();
    // X retires it: Back leaves the channel with no redundant Alpha stop.
    await close(sheet(page)).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.goBack();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    // Opening another thread replaces the inline one; Escape closes it.
    await clickRow(page, viewThread(page, roots(app)[1]));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("the conversation's jump control hides under the sheet, not the sheet's own", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const display = (locator) =>
      locator.evaluate(
        (button) => getComputedStyle(button.closest("[data-visible]")).display,
      );
    const conversationJump = page.locator(
      "[data-channel-timeline] button[data-jump-to-latest]",
    );
    await expect.poll(() => display(conversationJump)).not.toBe("none");
    await clickRow(page, viewThread(page, roots(app)[0]));
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => display(conversationJump)).toBe("none");
    const sheetJump = sheet(page).locator("button[data-jump-to-latest]");
    await expect.poll(() => display(sheetJump)).not.toBe("none");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => display(conversationJump)).not.toBe("none");
  });

  test("details nest over the inline thread: Back closes them first", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    details(app, "Nested findings", root);
    await showMore(sheet(page), "Nested findings").click();
    await expect(detailsSheet(page)).toBeVisible();
    await expect(detailsSheet(page).getByText(filler.trim())).toBeVisible();
    await page.goBack();
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(sheet(page)).toBeVisible();
    await expect(detailsSheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toBeVisible();
    // Reload restores the thread and the details over it.
    await page.reload();
    await expect(sheet(page)).toBeVisible();
    await expect(detailsSheet(page)).toBeVisible();
    // Escape closes only the details; X on the thread closes both for good.
    await page.keyboard.press("Escape");
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await showMore(sheet(page), "Nested findings").click();
    await expect(detailsSheet(page)).toBeVisible();
    await sheet(page)
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(detailsSheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("a thread sheet fits its content, starts at its header's edge and fades into its own surface", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [short, long] = roots(app);
    await clickRow(page, viewThread(page, short));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    // The first row's name starts where the header's material ends: the
    // row's own top padding lies under that fade, not below it.
    const lead = (surface) =>
      Math.abs(
        surface
          .querySelector("[data-message-scroller] [data-message-author]")
          .getBoundingClientRect().top -
          surface
            .querySelector("header .buzz-dialog-bar-material")
            .getBoundingClientRect().bottom,
      );
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    // A short thread hugs its rows instead of taking the full height.
    const room = (element) =>
      Number.parseFloat(getComputedStyle(element).maxHeight) -
      element.getBoundingClientRect().height;
    await expect.poll(() => sheet(page).evaluate(room)).toBeGreaterThan(100);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    for (let index = 0; index < 30; index++) app.reply(long.id, false, false);
    await clickRow(page, viewThread(page, long));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    // A long one grows to the maximum and reads up from its reply box.
    await expect.poll(() => sheet(page).evaluate(room)).toBeLessThan(1);
    await sheet(page)
      .locator("[data-message-scroller]")
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await expect(
      sheet(page).getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
    // Scrolled to its start, a long one leads as a short one does.
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    // The panel-colored composer fade would paint a darker strip over the
    // raised sheet; the sheet's own edge material replaces it.
    expect(
      await sheet(page)
        .locator("[data-thread-history-frame] + *")
        .evaluate((element) => getComputedStyle(element, "::before").content),
    ).toBe("none");
  });

  test("details in the conversation read over its composer", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    const timeline = page.locator("[data-channel-timeline]");
    await showMore(timeline, "Channel findings").click();
    const reader = detailsSheet(page);
    await expect(reader).toBeVisible();
    await expect(reader).toBeFocused();
    // The composer stays usable above the reader.
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks");
    await expect(reader).toBeVisible();
    await page.goBack();
    await expect(reader).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toBeVisible();
    await page.reload();
    await expect(detailsSheet(page)).toBeVisible();
    await detailsSheet(page).focus();
    await page.keyboard.press("Escape");
    await expect(detailsSheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });

  test("Move to side panel hands the thread, its draft and the reply it answers to a tab", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(reply(sheet(page))).toBeFocused();
    // The draft is aimed at a reply, not at the thread.
    const parent = sheet(page)
      .locator("[data-message-id]")
      .filter({ hasText: "Unread reply 0" });
    const parentId = await parent.getAttribute("data-message-id");
    await hoverMessage(parent);
    await parent.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(
      sheet(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await page.keyboard.type("Half-written reply");
    await sheet(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toHaveText("Half-written reply");
    await expect(
      side(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    // The handoff retired the inline visit: Back never shows both.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    // A thread that has a tab opens there, never inline beside it.
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(sheet(page)).toHaveCount(0);
    await expect(reply(side(page))).toHaveText("Half-written reply");
    // Sent from the tab, the draft still answers the reply it was aimed at.
    await reply(side(page)).press("Enter");
    await expect
      .poll(() =>
        app.report.publications
          .find(({ event }) => event?.content === "Half-written reply")
          ?.event.tags.filter(([key]) => key === "e"),
      )
      .toEqual([
        ["e", root.id, "", "root"],
        ["e", parentId, "", "reply"],
      ]);
  });

  // On a cold start the open channel is listed from saved membership until
  // its roster read settles, and the session reads no thread of it before
  // then. Only a real reload restores that listing with the thread's address.
  test("a thread restored before its channel is confirmed waits, then shows", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    let release;
    const roster = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = [route.request().postDataJSON()].flat();
      if (filters.some((filter) => filter?.kinds?.includes(39002))) {
        requested = true;
        await roster;
      }
      return route.continue().catch(() => {});
    });
    try {
      await page.reload();
      await expect.poll(() => requested).toBe(true);
      // The sheet is drawn once the saved channel is open. A thread mounted
      // on it would be refused at once, so settled geometry is past that.
      await expect(sheet(page)).toBeVisible();
      await settle(page);
      await expect(sheet(page).locator("[data-message-loading]")).toBeVisible();
      await expect(sheet(page).getByRole("alert")).toHaveCount(0);
      release();
      await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
      await expect(sheet(page).locator("[data-message-loading]")).toHaveCount(
        0,
      );
    } finally {
      release();
    }
  });
});

test.describe("Sending", () => {
  test.use({ productionBroker: false, sendChannels: ["alpha"] });

  test("a send from the composer closes the details read over it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    await showMore(
      page.locator("[data-channel-timeline]"),
      "Channel findings",
    ).click();
    await expect(detailsSheet(page)).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks, merging");
    await composer.press("Enter");
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(
      page.locator("[data-channel-timeline]").getByText("Thanks, merging"),
    ).toBeVisible();
    // Like ✕, the send retired the visit: Forward does not reopen it.
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });
});
