import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { readJournal } from "./reading.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
// The Archive shortcut acts on the last opened conversation.
const archiveShortcut = (page) =>
  page.keyboard.press(
    process.platform === "darwin" ? "Meta+Control+A" : "Control+Shift+E",
  );
const conversations = (inbox) =>
  inbox.getByRole("region", { name: /^Conversation in / });
const sideTabs = (inbox) =>
  inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab");
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  agentPeers: true,
  inboxSoloAgent: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Archive room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

async function choose(page, inbox, control, option) {
  await inbox
    .getByRole("button", { name: "Inbox filters", exact: true })
    .click();
  const menu = page.getByRole("menu", { name: "Inbox filters" });
  await expect(menu).toBeVisible();
  if (control === "Show") {
    await menu
      .getByRole("menuitemradio", { name: option, exact: true })
      .click();
  } else if (control === "Sender") {
    const people = menu.getByRole("menuitemcheckbox", { name: "People" });
    const agents = menu.getByRole("menuitemcheckbox", { name: "Agents" });
    if (
      option !== "Agents" &&
      (await people.getAttribute("aria-checked")) !== "true"
    )
      await people.click();
    if (
      option !== "Humans" &&
      (await agents.getAttribute("aria-checked")) !== "true"
    )
      await agents.click();
    if (
      option === "Agents" &&
      (await people.getAttribute("aria-checked")) === "true"
    )
      await people.click();
    if (
      option === "Humans" &&
      (await agents.getAttribute("aria-checked")) === "true"
    )
      await agents.click();
    await page.keyboard.press("Escape");
  } else {
    await menu
      .getByRole("menuitemradio", {
        name: option === "All activity" ? "All" : option,
        exact: true,
      })
      .click();
  }
  await expect(menu).toHaveCount(0);
}

test("Inbox status choices combine with attention filters and preserve them", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");

  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("All");
  await expect(
    inbox.getByRole("button", { name: "About Inbox archive" }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  const rowArchive = rows.getByRole("button", { name: /^Archive / });
  await page.mouse.move(0, 0);
  await expect(rowArchive.locator("xpath=..")).toHaveCSS("opacity", "0");
  await rows.hover();
  await expect(rowArchive.locator("xpath=..")).toHaveCSS("opacity", "1");

  await choose(page, inbox, "Activity type", "Mentions");
  await choose(page, inbox, "Sender", "Agents");
  await inbox.getByRole("button", { name: "Unread only" }).click();
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);

  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Agents");
  await expect(
    inbox.getByRole("button", { name: "Unread only" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await openPage(page, "Inbox");
  await expect(rows).toHaveCount(1);
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Archived");
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Mentions");
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Agents");
  await expect(
    inbox.getByRole("button", { name: "Unread only" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(conversations(inbox)).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("button", { name: /^Restore / })).toBeVisible();
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Mentions");
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toContainText("Agents");
  await expect(
    inbox.getByRole("button", { name: "Unread only" }),
  ).toHaveAttribute("aria-pressed", "true");
  // Preserve the focused status choice while relay activity updates rows.
  const trigger = inbox.getByRole("button", {
    name: "Inbox filters",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const archived = page.getByRole("menuitemradio", {
    name: "Archived",
    exact: true,
  });
  await expect(
    page.getByRole("menuitemradio", { name: "All", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitemradio", { name: "Drafts", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(archived).toBeFocused();
  app.append(
    "primary",
    channel,
    "Another review request",
    true,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(1);
  await expect(archived).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Inbox filters" })).toHaveCount(
    0,
  );
  await expect(trigger).toContainText("Archived");
  await expect(trigger).toBeFocused();
  await expect(rows).toHaveCount(1);
});

test("Inbox archive survives reload and reopens Threads before fresh Mentions", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  await expect(sideTabs(inbox)).toHaveCount(1);
  // Opening an unread row saves read state; row buttons are disabled and the
  // shortcut is deregistered until that save settles.
  await expect(rows.getByRole("button", { name: /^Open / })).toBeEnabled();
  await archiveShortcut(page);
  await expect(rows).toHaveCount(0);
  // With nothing left, its tab closes and focus returns to the list.
  await expect(conversations(inbox)).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Inbox filters", exact: true }),
  ).toBeFocused();
  await page.reload();
  await openPage(page, "Inbox");
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Restore conversation" }).click();
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  const { root } = app.inboxWindow;
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
    content: "Our current context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  await choose(page, inbox, "Activity type", "Mentions");
  app.append("primary", channel, "Agent progress", true, false, root.id);
  // Threads becoming visible proves the incoming reply was admitted before the
  // negative Mentions assertion; older tags must not resurface in that filter.
  await choose(page, inbox, "Activity type", "Threads");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Archive room");
  await choose(page, inbox, "Activity type", "All activity");
  await expect(rows).toHaveCount(1);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Inbox");
  await choose(page, inbox, "Activity type", "Mentions");
  await expect(rows).toHaveCount(0);
  await page.reload();
  await openPage(page, "Inbox");
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await choose(page, inbox, "Activity type", "Threads");
  await expect(rows).toHaveCount(1);
  await choose(page, inbox, "Activity type", "Mentions");
  await expect(rows).toHaveCount(0);
  app.append(
    "primary",
    channel,
    "John, please decide",
    true,
    false,
    root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(1);
  // Retirement persists even after the newer evidence is reloaded.
  await page.reload();
  await openPage(page, "Inbox");
  await expect(rows).toHaveCount(1);
});

// Browser-only: live DM delivery through the production broker and browser
// reload must retain ordinary reopening without resurfacing an archived old tag.
// Reply/top-level classification matrices remain in the mounted session tests.
test.describe("DM archive delivery", () => {
  test.use({ dmMembers: { "dm-peer": [0] } });

  test("ordinary DM activity reopens across reload without resurfacing old mentions", async ({
    page,
    app,
  }) => {
    const dm = "dm-peer";
    const root = app.sign({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", dm]],
      content: "Our DM discussion",
    });
    app.histories.get(`primary/${dm}`).push(root);
    app.append(
      "primary",
      dm,
      "Earlier DM reply",
      false,
      false,
      root.id,
      undefined,
      [["p", app.viewer]],
    );
    // app.append advances signed event time one second per message. Pin Date,
    // not timers, so startup speed cannot put Archive after the fresh mention.
    await page.clock.setFixedTime(new Date((root.created_at + 1) * 1000));
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const rows = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem");
    await choose(page, inbox, "Activity type", "DMs");
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: /^Open / }).click();
    // A DM opens whole; its root carries the mentioned reply.
    await expect(
      inbox
        .getByRole("region", {
          name: "Conversation in Alice Fixture",
          exact: true,
        })
        .getByText("Our DM discussion", { exact: true }),
    ).toBeVisible();
    await rows.getByRole("button", { name: /^Archive / }).click();
    await expect(rows).toHaveCount(0);
    await expect(conversations(inbox)).toHaveCount(0);
    await choose(page, inbox, "Show", "Archived");
    app.append("primary", dm, "New ordinary DM message", true, false);
    await choose(page, inbox, "Show", "Inbox");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("New ordinary DM message");
    await page.reload();
    await openPage(page, "Inbox");
    await expect(rows).toHaveCount(1);
    await choose(page, inbox, "Show", "Archived");
    await expect(rows).toHaveCount(0);
    await choose(page, inbox, "Activity type", "Mentions");
    const dmRows = inbox.locator('[data-inbox-row="dm-peer:dm-peer"]');
    await expect(dmRows).toHaveCount(0);
    await choose(page, inbox, "Show", "Inbox");
    await expect(dmRows).toHaveCount(0);
    app.append(
      "primary",
      dm,
      "Fresh explicit DM mention",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    await choose(page, inbox, "Activity type", "DMs");
    await expect(dmRows).toHaveCount(1);
    await expect(dmRows).toContainText("Fresh explicit DM mention");
    await page.reload();
    await openPage(page, "Inbox");
    await expect(dmRows).toHaveCount(1);
    await choose(page, inbox, "Activity type", "Mentions");
    await expect(dmRows).toHaveCount(0);
  });
});

// Browser-only: a saved grouped archive must not drive a render/storage loop when
// the real unread projection currently exposes only unresolved singleton replies.
test("saved grouped archive converges with unresolved Inbox evidence across reload", async ({
  page,
  app,
}) => {
  const rootId = "f".repeat(64);
  const replies = ["First unresolved request", "Second unresolved request"].map(
    (content) =>
      app.append("primary", channel, content, false, false, rootId, undefined, [
        ["p", app.viewer],
      ]),
  );
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await choose(page, inbox, "Show", "Archived");
  await choose(page, inbox, "Show", "Inbox");
  const saved = await page.evaluate(
    ({ channel, rootId, messageIds }) => {
      const filterKey = Object.keys(localStorage).find(
        (key) =>
          key.startsWith("buzz-view.v1:") &&
          JSON.parse(key.slice("buzz-view.v1:".length))[1] === "inbox:filters",
      );
      if (!filterKey) throw new Error("Missing Inbox filter scope");
      const [scope] = JSON.parse(filterKey.slice("buzz-view.v1:".length));
      const key = `buzz-view.v1:${JSON.stringify([scope, "inbox:archives"])}`;
      const revision = JSON.stringify([
        {
          id: `${channel}:${rootId}`,
          channelId: channel,
          through: Math.floor(Date.now() / 1000),
          messageIds,
        },
      ]);
      localStorage.setItem(key, revision);
      return { key, revision };
    },
    { channel, rootId, messageIds: replies.map(({ id }) => id) },
  );
  await page.addInitScript(() => {
    window.archiveReconciliationWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes("inbox:archives")) window.archiveReconciliationWrites++;
      return setItem.call(this, key, value);
    };
  });
  for (let pass = 0; pass < 2; pass++) {
    await page.reload();
    await openPage(page, "Inbox");
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await choose(page, inbox, "Show", "Archived");
    await expect(rows).toHaveCount(2);
    await choose(page, inbox, "Show", "Inbox");
    await expect(rows).toHaveCount(1);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), saved.key),
    ).toBe(saved.revision);
    expect(await page.evaluate(() => window.archiveReconciliationWrites)).toBe(
      0,
    );
  }
});

// Browser coverage proves Inbox/thread/composer wiring without an archive-on-send hook.
test("Inbox sending keeps the conversation open until manually archived", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(
    inbox.getByText("Checking recent activity…", { exact: true }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  await expect(
    inbox.getByRole("checkbox", { name: "Archive on send" }),
  ).toHaveCount(0);
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  await editor.fill("Keep this conversation");
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect(editor).toHaveText("");
  await expect(
    detail.getByText("Keep this conversation", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(editor).toBeVisible();
  // The shortcut archives the open conversation from its composer.
  await editor.focus();
  await archiveShortcut(page);
  await expect(rows).toHaveCount(0);
  await expect(detail).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
});

// Browser-only: verify selection and original rich-editor identity across list changes.
test("archiving the open conversation advances its tab, then closes it", async ({
  page,
  app,
}) => {
  const request = app.append(
    "primary",
    channel,
    "Second explicit request",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Second explicit request" });
  await thread.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const root = detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`);
  await expect(root).toBeVisible();
  await expect(sideTabs(inbox)).toHaveCount(1);
  // Row buttons are disabled while the opened row's read-state save is pending.
  await expect(thread.getByRole("button", { name: /^Open / })).toBeEnabled();
  await archiveShortcut(page);
  await expect(rows).toHaveCount(1);
  // The remaining conversation replaces the archived one's tab and is selected.
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(root).toHaveCount(0);
  await expect(
    detail.locator(`[data-message-id="${request.id}"]`),
  ).toBeInViewport();
  await expect(next).toHaveAttribute("data-selected", "true");
  // Advancing reads the successor, so its save must settle before the chord.
  await expect(next.getByRole("button", { name: /^Open / })).toBeEnabled();
  await archiveShortcut(page);
  await expect(rows).toHaveCount(0);
  await expect(detail).toHaveCount(0);
});
// Browser-only: row hit targets and the keyboard menu must retarget the real
// reader/editor, then restore its durable rich draft when the archive is reopened.
// Successor/fallback/empty-list matrices live in InboxPage.test.tsx.
test("selected row button advances and menu closes without losing the original draft", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const editor = conversations(inbox).getByRole("textbox");
  await editor.fill("Keep the selected archive draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await thread.getByRole("button", { name: /^Archive / }).click();
  await expect(rows).toHaveCount(1);
  await expect(next).toHaveAttribute("data-selected", "true");
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  await expect(editor).not.toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
  // The successor's tab replaces the archived one and reveals its message.
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(
    conversations(inbox).locator(
      `[data-message-id="${app.inboxWindow.root.id}"]`,
    ),
  ).toHaveCount(0);
  const successor = conversations(inbox).locator(
    `[data-message-id="${neighbor.id}"]`,
  );
  await expect(successor).toBeInViewport();
  await next.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  await expect(conversations(inbox)).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  await expect(editor).toHaveText("Keep the selected archive draft");
});

// Browser-only: a row menu beside a live rich editor must not replace it; a
// Restoring the other row preserves its unread evidence across status changes.
test("unselected row Archive preserves the open editor and unread neighbor", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const target = conversations(inbox).locator(
    `[data-message-id="${app.inboxWindow.replies[0].id}"]`,
  );
  await expect(target).toBeInViewport();
  // Finish entry reveal and its next-frame acknowledgement before taking the
  // editor/row-focus baseline; list aria-busy does not cover reader positioning.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const editor = conversations(inbox).getByRole("textbox");
  await editor.fill("Keep the unselected archive draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  await expect(list).toHaveAttribute("aria-busy", "false");
  await next.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(1);
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(thread).toHaveAttribute("data-selected", "true");
  // Archiving another row moves focus to the next row and leaves the tab.
  await expect(thread.getByRole("button", { name: /^Open / })).toBeFocused();
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(editor).toHaveText("Keep the unselected archive draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
  expect(
    (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
  ).toBeUndefined();
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await next.getByRole("button", { name: /^Restore / }).click();
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(2);
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  expect(
    (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
  ).toBeUndefined();
});

test("reply and fresh mention reopen their filters without replacing composer draft", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Archive / }).click();
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  await editor.fill("Unsent mention retention draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-composer";
  });
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", app.inboxWindow.root.id, "", "reply"],
    ],
    content: "Current thread context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  app.append(
    "primary",
    channel,
    "Ordinary peer reply",
    true,
    false,
    app.inboxWindow.root.id,
  );
  await expect(detail).toContainText("Ordinary peer reply");
  await expect(rows).toHaveCount(0);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
  // Changing Show deliberately closes a visit; keep the Archived view open
  // while Activity type changes and incoming events update its membership.
  await choose(page, inbox, "Activity type", "Threads");
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Activity type", "Mentions");
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
  app.append(
    "primary",
    channel,
    "Fresh peer explicit mention",
    true,
    false,
    app.inboxWindow.root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(0);
  await expect(detail).toContainText("Fresh peer explicit mention");
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
});

// Browser-only: real same-origin storage events must reconcile two mounted windows.
test("same-account windows reconcile filters and archive intent without reload", async ({
  page,
  context,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const other = await context.newPage();
  app.watchPageErrors(other);
  try {
    await other.goto(app.origin);
    await openPage(other, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const sibling = other.getByRole("region", { name: "Inbox", exact: true });
    const rows = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem");
    const siblingRows = sibling
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
    await choose(page, inbox, "Activity type", "Mentions");
    await choose(page, inbox, "Sender", "Agents");
    await inbox.getByRole("button", { name: "Unread only" }).click();
    await expect(
      sibling.getByRole("button", { name: "Inbox filters", exact: true }),
    ).toContainText("Mentions");
    await expect(
      sibling.getByRole("button", { name: "Inbox filters", exact: true }),
    ).toContainText("Agents");
    await expect(
      sibling.getByRole("button", { name: "Unread only" }),
    ).toHaveAttribute("aria-pressed", "true");
    await rows.getByRole("button", { name: /^Archive / }).click();
    await expect(rows).toHaveCount(0);
    await expect(siblingRows).toHaveCount(0);
    await choose(other, sibling, "Show", "Archived");
    await expect(
      inbox.getByRole("button", { name: "Inbox filters", exact: true }),
    ).toContainText("Archived");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
    await siblingRows.getByRole("button", { name: /^Restore / }).click();
    await expect(rows).toHaveCount(0);
    await expect(siblingRows).toHaveCount(0);
    await choose(page, inbox, "Show", "Inbox");
    await expect(
      sibling.getByRole("button", { name: "Inbox filters", exact: true }),
    ).toHaveText("Mentions · Agents");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
  } finally {
    await other.close();
  }
});
