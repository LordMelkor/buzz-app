import { pauseClock } from "./clock.mjs";
import { test, expect } from "./fixture.mjs";
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { newChat, openPage, sendOnlyTo } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const destination = "55555555-5555-4555-8555-555555555555";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other, destination],
  channelNames: { [id]: "Alpha", [other]: "Beta", [destination]: "Team" },
  soloChannels: [id, other],
  ownSoloChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, [destination]: 0 },
});

test("chat row menus open Share with the chat's people and restore focus", async ({
  page,
  app,
}) => {
  const agents = ["Blossom", "Bubbles"].map((name) =>
    app.serveProfile(generateSecretKey(), { name, is_agent: true }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === id)
          ? app.signRelay({
              ...event,
              tags: [
                ...event.tags,
                ...agents.map((agent) => ["p", agent.pubkey, "", "bot"]),
              ],
            })
          : event,
      ),
    });
  });
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Alpha",
    exact: true,
  });
  // Lifecycle items mount after each opening's permission read.
  const lifecycleReady = menu.getByRole("menuitem", {
    name: "Delete chat",
    exact: true,
  });
  await expect(lifecycleReady).toBeVisible();
  const actions = await menu.getByRole("menuitem").allTextContents();
  expect(actions).toContain("Share access");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New chat", exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  await sidebar
    .getByRole("button", { name: "Actions for Alpha", exact: true })
    .click();
  await expect(lifecycleReady).toBeVisible();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await row.focus();
  await row.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", { name: "Share access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Share access",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("searchbox", { name: "Search people and channels" }),
  ).toBeFocused();
  const agentGroup = dialog.getByRole("region", {
    name: "Agents",
    exact: true,
  });
  await expect(agentGroup.getByText("Blossom", { exact: true })).toBeVisible();
  await expect(agentGroup.getByText("Bubbles", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});

test.describe("Berd-style Solo project organization", () => {
  test.use({ soloAgentNames: ["Owned Honey"] });
  test("a project retains two chats and their exact tagged drafts", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    // Stable identity: after reload an unread count joins the accessible label.
    const row = sidebar.locator(`[data-solo-channel-id="${id}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
    await page.getByRole("menuitem", { name: "New workspace" }).click();
    const dialog = page.getByRole("dialog");
    // Wait until the exiting menus are gone and the dialog's initial focus has
    // settled on the field. The modal hides the menus from role queries.
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    const field = dialog.getByRole("textbox", { name: "Workspace name" });
    await expect(field).toBeFocused();
    await field.fill("Work");
    await expect(field).toHaveValue("Work");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(sidebar.getByText("Saving workspace…")).not.toBeVisible();
    await expect(sidebar.getByRole("alert")).toHaveCount(0);
    const project = sidebar.getByRole("button", { name: "Work", exact: true });
    await expect(project).toBeVisible();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(1);
    await page.clock.install();
    await page.clock.runFor(1_100);
    await page.clock.resume();

    await newChat(page);
    for (const [before, choice, after] of [
      ["Add workspace", "Work", "Workspace: Work"],
      ["Workspace: Work", "No workspace", "Add workspace"],
    ]) {
      const trigger = page.getByRole("button", { name: before, exact: true });
      await trigger.focus();
      await trigger.press("Enter");
      const popup = page.getByRole("menu").filter({
        has: page.getByRole("menuitemradio", {
          name: "No workspace",
          exact: true,
        }),
      });
      const option = popup.getByRole("menuitemradio", {
        name: choice,
        exact: true,
      });
      await option.focus();
      await option.press("Enter");
      // Wait for popup teardown, when Base UI restores focus to the trigger.
      await expect(popup).toHaveCount(0);
      await expect
        .soft(page.getByRole("button", { name: after, exact: true }))
        .toBeFocused();
    }

    const beta = sidebar.getByRole("button", { name: "Beta", exact: true });
    await beta.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(2);
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();
    // Filing is demonstrated by disclosure behavior, not child indentation.
    await project.click();
    await expect(row).not.toBeVisible();
    await expect(beta).not.toBeVisible();
    await project.click();
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();

    await sidebar.getByText("Alpha", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Workspace: Work", exact: true }),
    ).toBeVisible();
    app.soloAgentMessage(id, "Agent follow-up fixture");
    const [agent] = app.soloAgents;
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    // Agents-only Solo chats address agents from the composer's pill, not the
    // text.
    await expect(composer).toHaveText("");
    const pill = page.getByRole("button", {
      name: /Change agents$|^Choose agent$/,
    });
    // An existing chat starts addressed to one of its agents.
    await expect(pill).toHaveAccessibleName(/^Sending to .+\. Change agents$/);
    await sendOnlyTo(page, pill, agent);
    const tag = page.getByRole("button", {
      name: `Sending to ${agent.name}. Change agents`,
      exact: true,
    });
    await expect(tag).toBeVisible();
    const agentMessage = page.getByText("Agent follow-up fixture", {
      exact: true,
    });
    await expect(agentMessage).toBeVisible();
    await composer.press("End");
    await page.keyboard.insertText("Remember the launch checklist");
    await composer.press("Enter");
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await expect.poll(() => publications().length).toBe(1);
    const sent = publications()[0].event;
    expect(verifyEvent(sent)).toBe(true);
    expect(sent.tags.filter(([key]) => key === "p")).toEqual([
      ["p", agent.pubkey],
    ]);
    expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", id]]);
    const viewerMessage = page.locator(`[data-message-id="${sent.id}"]`);
    await expect(viewerMessage).toContainText("Remember the launch checklist");
    await expect(tag).toBeVisible();
    await composer.press("End");
    await page.keyboard.insertText("Keep this follow-up draft");
    await beta.click();
    await expect(composer).not.toContainText("Keep this follow-up draft");
    await sidebar.getByText("Alpha", { exact: true }).click();
    await expect(composer).toContainText("Keep this follow-up draft");
    await expect(tag).toBeVisible();
    await page.reload();
    await expect(composer).toContainText("Keep this follow-up draft");
    await expect(tag).toBeVisible();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();
    await expect(agentMessage).toBeVisible();
  });
});

// A real pointer owns the activation distance and hit testing; the saved move
// itself is the row menu's.
test("dragging a chat between a project and Chats saves and reloads like Move to", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const chat = (name) => sidebar.getByRole("button", { name, exact: true });
  const inProject = (name) =>
    sidebar
      .locator("[data-project]")
      .getByRole("button", { name, exact: true });
  const published = async (count) => {
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(count);
    // Each replaceable preference write needs a later second.
    await page.clock.runFor(1_100);
    return app.report.sidebarPublications.at(-1).blob.value.assignments;
  };
  // Hold a real pointer drag over a section header, then release it.
  async function drag(name, section, target = true) {
    const from = await chat(name).boundingBox();
    const to = await chat(section).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 8,
    });
    await expect(sidebar.locator("[data-channel-dragging]")).toBeVisible();
    await expect(sidebar.locator("[data-drop-target]")).toHaveCount(
      target ? 1 : 0,
    );
    await page.mouse.up();
    await expect(sidebar.locator("[data-channel-dragging]")).toHaveCount(0);
  }
  await page.clock.install();
  await chat("Alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog");
  // Wait until the exiting menus are gone and the dialog's initial focus has
  // settled on the field. The modal hides the menus from role queries.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  const field = dialog.getByRole("textbox", { name: "Workspace name" });
  await expect(field).toBeFocused();
  await field.fill("Work");
  await expect(field).toHaveValue("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(inProject("Alpha")).toBeVisible();
  const work = (await published(1))[id];

  await drag("Alpha", "Chats");
  await expect(chat("Alpha")).toBeFocused();
  await expect(inProject("Alpha")).toHaveCount(0);
  expect(await published(2)).toEqual({});

  await drag("Beta", "Work");
  await expect(inProject("Beta")).toBeFocused();
  expect(await published(3)).toEqual({ [other]: work });

  // Dropping back on the chat's own section is not a move.
  await drag("Beta", "Work", false);
  await expect(inProject("Beta")).toBeVisible();
  expect(app.report.sidebarPublications).toHaveLength(3);

  await page.reload();
  await expect(inProject("Beta")).toBeVisible();
  await expect(chat("Alpha")).toBeVisible();
  await expect(inProject("Alpha")).toHaveCount(0);
});

// App wiring proof: grants and the normal link publication preserve Solo placement,
// identity/history and navigation, with a held signed grant readback barrier.
test("Share grants access and posts a link without promoting or moving the Solo chat", async ({
  page,
  app,
}) => {
  await page.clock.install();
  const person = app.serveProfile(generateSecretKey(), { name: "Aria" });
  const grants = [];
  const evidence = [];
  let signalReadback;
  const requestedReadback = new Promise((resolve) => {
    signalReadback = resolve;
  });
  let releaseReadback;
  const heldReadback = new Promise((resolve) => {
    releaseReadback = resolve;
  });
  let readbackHeld = false;
  let rosterTime = Math.floor(Date.now() / 1000);
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.kinds?.includes(0) && filter.search === "Aria",
      )
    ) {
      return route.fulfill({ json: [person] });
    }
    const response = await route.fetch();
    const events = await response.json();
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      if (
        !readbackHeld &&
        grants.length &&
        filters.some(
          (filter) =>
            filter.kinds?.includes(39002) &&
            filter["#d"]?.includes(id) &&
            filter.consistency === "strong",
        ) &&
        events.some(
          (event) =>
            event.kind === 39002 &&
            event.tags.some(([key, value]) => key === "d" && value === id),
        )
      ) {
        readbackHeld = true;
        evidence.push("readback-requested");
        signalReadback();
        await heldReadback;
        evidence.push("readback-released");
      }
      return route.fulfill({
        json: events.map((event) => {
          const room =
            event.kind === 39002 &&
            event.tags.find(([key]) => key === "d")?.[1];
          // Aria is a Team member, so sharing to Team grants her chat access.
          if (room === destination)
            return app.signRelay({
              kind: 39002,
              content: "",
              created_at: event.created_at,
              tags: [...event.tags, ["p", person.pubkey, "", "member"]],
            });
          if (room !== id) return event;
          return app.signRelay({
            kind: 39002,
            content: "",
            created_at: ++rosterTime,
            tags: [
              ...event.tags,
              ...grants.map((grant) => [
                "p",
                grant.tags.find(([key]) => key === "p")[1],
                "",
                "member",
              ]),
            ],
          });
        }),
      });
    }
    return route.fulfill({ response });
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind === 9) evidence.push("link");
    if (event.kind !== 9000) return route.continue();
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(app.viewer);
    grants.push(event);
    evidence.push("grant");
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Share access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Share access" });
  const search = dialog.getByRole("searchbox", {
    name: "Search people and channels",
  });
  // Text entry starts after the menu-to-dialog transition.
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await search.fill("Team");
  await dialog
    .getByRole("button", { name: "Select #Team", exact: true })
    .click();
  const primary = dialog.getByRole("button", {
    name: "Share",
    exact: true,
  });
  const copy = dialog.getByRole("button", { name: "Copy link", exact: true });
  // Copy link leads Share. At a narrow width with enlarged text
  // the footer actions wrap; real flex wrapping, Tab order and hit testing are
  // invisible to mounted DOM tests.
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const actions = dialog.locator(".buzz-dialog-actions");
  await expect
    .poll(() =>
      actions.evaluate((footer) => {
        const widest = Math.max(
          ...[...footer.querySelectorAll("button")].map(
            (button) => button.getBoundingClientRect().width,
          ),
        );
        // Include the shared focus-ring inset around an oversized action.
        const style = getComputedStyle(footer);
        const inset =
          parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        return (
          footer.scrollWidth - Math.max(footer.clientWidth, widest + inset)
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const copied = await copy.boundingBox();
      const shared = await primary.boundingBox();
      return shared.y >= copied.y + copied.height;
    })
    .toBe(true);
  // Focus the preceding body control, then traverse every wrapped action.
  await search.focus();
  for (const action of [copy, primary]) {
    for (
      let step = 0;
      !(await action.evaluate((el) => el === document.activeElement));
      step++
    ) {
      expect(step).toBeLessThan(12);
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
          ),
        )
        .toBe(false);
    }
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        action.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  const hint = page.getByRole("tooltip").filter({
    hasText: "Sharing grants access and posts a link in the selected channel.",
  });
  await primary.hover();
  await expect(hint).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(hint).not.toBeVisible();
  await copy.focus();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await expect(hint).toBeVisible();
  await expect(primary).toHaveAccessibleDescription(
    "Sharing grants access and posts a link in the selected channel.",
  );
  // Tooltip dismissal consumes only its own Escape, not the enclosing modal.
  await page.keyboard.press("Escape");
  await expect(hint).not.toBeVisible();
  await expect(dialog).toBeVisible();
  // Hold the page clock so the held readback cannot reach its read deadline.
  await pauseClock(page, 100);
  try {
    await page.keyboard.press("Enter");
    await requestedReadback;
    await expect(dialog).toBeVisible();
    await expect(primary).toHaveAttribute("aria-busy", "true");
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    expect(evidence).toEqual(["grant", "readback-requested"]);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(0);
    releaseReadback();
    await page.clock.resume();
    await expect(dialog).not.toBeVisible();
    // The dialog closes once the link is queued; the Outbox then posts it.
    await expect
      .poll(() => evidence)
      .toEqual(["grant", "readback-requested", "readback-released", "link"]);
  } finally {
    releaseReadback();
    await page.clock.resume();
  }
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(grants).toHaveLength(1);
  expect(grants[0].tags).toContainEqual(["h", id]);
  expect(grants[0].tags).toContainEqual(["p", person.pubkey]);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  const links = app.report.publications.filter(({ event }) => event.kind === 9);
  expect(links).toHaveLength(1);
  expect(links[0].event.tags).toContainEqual(["h", destination]);
  expect(links[0].event.tags.filter(([key]) => key === "p")).toHaveLength(0);
  expect(links[0].event.content).toBe(`[Chat: Alpha](buzz://channel/${id})`);
});

// App composition boundary: signed metadata switches Messages discoverability
// without a route handoff, a new conversation, or a Solo preference write.
test("explicit conversion moves the same conversation from Solo to Messages and keeps history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", {
    name: "Solo conversations",
  });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Convert to channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(
    dialog.getByRole("radio", { name: "Private", exact: true }),
  ).toBeChecked();
  const publicChoice = dialog.getByRole("radio", {
    name: "Public",
    exact: true,
  });
  await expect(publicChoice).toHaveAccessibleDescription(
    "Everyone in this community will be able to view this channel’s full history.",
  );
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(convert).toBeEnabled();
  await publicChoice.click();
  await expect(publicChoice).toBeChecked();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await convert.click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Channel actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(`[data-solo-channel-id="${id}"]`)).toHaveCount(
    0,
  );
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  const event = app.report.detailsPublications[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(9002);
  expect(event.tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
    ["visibility", "open"],
    ["t", ""],
  ]);
  // An unfiled chat has no project assignment to remove.
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  expect(
    app.report.publications.filter(({ event }) =>
      [9, 9000, 9007, 30315].includes(event.kind),
    ),
  ).toHaveLength(0);
  await openPage(page, "Messages");
  const messages = page.getByRole("button", { name: "Alpha", exact: true });
  await expect(messages).toBeVisible();
  await messages.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await newChat(page);
  await expect(row).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});

// Browser-only: native modal focus handoff to a replacement Messages header.
// The held metadata/completion ordering matrix lives in the mounted page test.
test("Messages conversion restores focus after its chat header is replaced", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      channelId: id,
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  ).toEqual({ status: "opened" });
  // Conversion lives in the chat's actions menu, not the access dialog.
  const trigger = page.getByRole("button", {
    name: "Chat actions",
    exact: true,
  });
  const convert = page.getByRole("menuitem", { name: "Convert to channel" });
  await trigger.click();
  await convert.click();
  const dialog = page.getByRole("dialog", { name: "Convert to channel" });
  await expect(
    dialog.getByRole("button", { name: "Convert to channel" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await convert.click();
  const confirm = dialog.getByRole("button", { name: "Convert to channel" });
  await expect(confirm).toBeEnabled();
  await confirm.focus();
  await confirm.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(app.report.detailsPublications).toHaveLength(1);
  expect(app.report.detailsPublications[0].tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
    ["t", ""],
  ]);
});

test("unified chat naming and lifetime retain host focus and save only explicit changes", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  // A New chat draft keeps its own Chat settings button; a created chat
  // reaches settings through its Chat actions menu. Each keeps return focus.
  const draftActions = page.getByRole("button", {
    name: "Chat settings",
    exact: true,
  });
  const actions = page.getByRole("button", {
    name: "Chat actions",
    exact: true,
  });
  const openSettings = async () => {
    await actions.click();
    await page
      .getByRole("menuitem", { name: "Chat settings", exact: true })
      .click();
  };
  await draftActions.click();
  const settings = page.getByRole("dialog", {
    name: "Edit chat",
    exact: true,
  });
  const canvas = settings.getByRole("textbox", { name: /^Instructions/ });
  await expect(canvas).toBeVisible();
  await canvas.fill("Keep this local draft");
  const draftName = settings.getByRole("textbox", {
    name: "Chat name Optional",
    exact: true,
  });
  await draftName.fill("Make contrast meet accessibility standards");
  const draftTemporary = settings.getByRole("radio", {
    name: "Temporary",
    exact: true,
  });
  await settings
    .locator("label")
    .filter({
      has: page.getByRole("radio", { name: "Temporary", exact: true }),
    })
    .click();
  await expect(draftTemporary).toBeChecked();
  await settings.getByRole("button", { name: "Increase duration" }).click();
  await expect(draftTemporary).toHaveAccessibleDescription(
    "Archives after 2 weeks without activity.",
  );
  await settings.getByRole("button", { name: "Decrease duration" }).click();
  await expect(draftTemporary).toHaveAccessibleDescription(
    "Archives after 7 days without activity.",
  );
  const draftSave = settings.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  // Real narrow, enlarged-text layout: Tab must expose Save without programmatic
  // focus/scroll or resetting the text size to mask clipping.
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await draftName.focus();
  let tabs = 0;
  while (
    tabs < 20 &&
    !(await draftSave.evaluate((el) => el === document.activeElement))
  ) {
    await page.keyboard.press("Tab");
    tabs += 1;
  }
  await expect(draftSave).toBeFocused();
  await expect(draftSave).toBeInViewport();
  await expect
    .poll(() =>
      draftSave.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ),
        );
      }),
    )
    .toBe(true);
  // The rest of the journey needs the desktop sidebar.
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  await draftSave.focus();
  await expect(draftSave).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings).not.toBeVisible();
  await expect(draftActions).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await draftActions.click();
  await expect(canvas).toHaveValue("Keep this local draft");
  await expect(draftName).toHaveValue(
    "Make contrast meet accessibility standards",
  );
  await expect(draftTemporary).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();

  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await openSettings();
  const lifetime = page.getByRole("dialog", {
    name: "Edit chat",
    exact: true,
  });
  const save = lifetime.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await expect(save).toBeEnabled();
  await expect(
    lifetime.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  const ongoing = lifetime.getByRole("radio", { name: "Ongoing", exact: true });
  const temporary = lifetime.getByRole("radio", {
    name: "Temporary",
    exact: true,
  });
  await ongoing.focus();
  await page.keyboard.press("ArrowDown");
  await expect(temporary).toBeChecked();
  await lifetime.getByRole("button", { name: "Increase duration" }).click();
  await save.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(lifetime).not.toBeVisible();
  await expect(actions).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Chat settings", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await expect(ongoing).toBeChecked();
  await lifetime
    .locator("label")
    .filter({
      has: page.getByRole("radio", { name: "Temporary", exact: true }),
    })
    .click();
  await lifetime.getByRole("button", { name: "Increase duration" }).click();
  await lifetime
    .getByRole("textbox", { name: "Chat name", exact: true })
    .fill("Make contrast meet accessibility standards");
  // Observe the browser's actual confirmation read without proxying its queries
  // through a separate APIRequestContext connection pool.
  const [readback] = await Promise.all([
    page.waitForResponse(async (response) => {
      if (
        !response.url().endsWith("/api/relay/primary/query") ||
        !response.ok() ||
        !response
          .request()
          .postDataJSON()
          .some((filter) => filter.kinds?.includes(39000))
      )
        return false;
      return (await response.json()).some(
        (event) =>
          event.kind === 39000 &&
          event.tags.some(([key, value]) => key === "d" && value === id) &&
          event.tags.some(
            ([key, value]) => key === "ttl" && value === "1209600",
          ),
      );
    }),
    save.click(),
  ]);
  await expect(lifetime).not.toBeVisible();
  const renamedRow = sidebar.getByRole("button", {
    name: "Make contrast meet accessibility standards",
    exact: true,
  });
  await expect(renamedRow).toBeFocused();
  await expect(renamedRow).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  const event = app.report.detailsPublications[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(9002);
  expect(event.tags).toEqual([
    ["h", id],
    ["name", "Make contrast meet accessibility standards"],
    ["about", ""],
    ["ttl", "1209600"],
    ["t", "buzz.solo"],
    ["t", "buzz.session.named"],
  ]);
  const saved = (await readback.json()).find(
    (entry) =>
      entry.kind === 39000 &&
      entry.tags.some(([key, value]) => key === "d" && value === id) &&
      entry.tags.some(([key, value]) => key === "ttl" && value === "1209600"),
  );
  expect(saved).toBeDefined();
  expect(verifyEvent(saved)).toBe(true);
  expect(saved.tags).toContainEqual(["private"]);
  expect(saved.tags.filter(([key]) => key === "t")).toEqual([
    ["t", "stream"],
    ["t", "buzz.solo"],
    ["t", "buzz.session.named"],
  ]);
  expect(saved.tags).not.toContainEqual(["public"]);
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  expect(
    app.report.publications.filter(({ event }) =>
      [9, 9000, 9007, 30315, 40100].includes(event.kind),
    ),
  ).toHaveLength(0);
  await renamedRow.focus();
  await renamedRow.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Chat settings", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await expect(temporary).toHaveAccessibleDescription(
    "Archives after 2 weeks without activity.",
  );
  await page.keyboard.press("Escape");

  await expect(renamedRow).toBeFocused();
  // Inline renaming exercises native text selection and the actual sidebar host.
  await renamedRow.dblclick();
  await expect(lifetime).not.toBeVisible();
  const inlineName = sidebar.getByRole("textbox", {
    name: "Chat name",
    exact: true,
  });
  await expect(inlineName).toBeFocused();
  await expect
    .poll(() =>
      inlineName.evaluate((input) => [
        input.selectionStart,
        input.selectionEnd,
        input.value.length,
      ]),
    )
    .toEqual([0, 42, 42]);
  await page.keyboard.type("Inline plan");
  await inlineName.press("Enter");
  await expect(inlineName).toHaveCount(0);
  const inlineRow = sidebar.getByRole("button", {
    name: "Inline plan",
    exact: true,
  });
  await expect(inlineRow).toBeVisible();
  await expect(inlineRow).toBeFocused();
  expect(app.report.detailsPublications).toHaveLength(2);
  const rename = app.report.detailsPublications[1];
  expect(verifyEvent(rename)).toBe(true);
  expect(rename.tags).toContainEqual(["name", "Inline plan"]);
  expect(rename.tags.some(([key]) => key === "ttl")).toBe(false);
  await inlineRow.dblclick();
  await expect(inlineName).toBeFocused();
  await page.keyboard.type("Discard this");
  await inlineName.press("Escape");
  await expect(inlineName).toHaveCount(0);
  await expect(inlineRow).toBeFocused();
  expect(app.report.detailsPublications).toHaveLength(2);
});

// Native caret placement after focus handoffs and popup picks needs a browser.
test.describe("Solo composer caret", () => {
  test.use({ soloAgentNames: ["Owned Honey", "Owned Brain"] });
  test("a returning draft resumes at its end and picking agents leaves the text alone", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const caret = () =>
      composer.evaluate((el) => [el.value, el.selectionStart, el.selectionEnd]);
    const [honey, brain] = app.soloAgents;
    // Agents-only Solo chats address agents from the composer's pill.
    const pill = page.getByRole("button", {
      name: /Change agents$|^Choose agent$/,
    });
    const pick = async (agent) => {
      await sendOnlyTo(page, pill, agent);
      await expect(pill).toHaveAccessibleName(
        `Sending to ${agent.name}. Change agents`,
      );
    };
    await expect(pill).toHaveAccessibleName(
      `Sending to ${honey.name}. Change agents`,
    );
    await expect(composer).toHaveText("");
    await page.keyboard.insertText("first");
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(composer).toHaveText("");
    await composer.click();
    await page.keyboard.insertText("alpha draft");
    // Returning focuses the restored draft at its end.
    await newChat(page);
    await expect.poll(caret).toEqual(["first", 5, 5]);

    // Picking an agent changes the pill, not the text; typing continues
    // where the caret was.
    await pick(brain);
    await expect.poll(caret).toEqual(["first", 5, 5]);
    await expect(composer).toBeFocused();
    await page.keyboard.insertText(" again");
    await expect(composer).toHaveText("first again");

    // A blurred composer's prose is left alone too.
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(composer).toHaveText("alpha draft");
    await composer.blur();
    await pick(honey);
    await expect(composer).toHaveText("alpha draft");
  });

  test("menu picks that edit typed tags keep keyboard focus in the menu, and Tab leaves it", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const [honey, brain] = app.soloAgents;
    await composer.click();
    await page.keyboard.type(`@${honey.name}`);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("hello");
    await expect(composer).toHaveText(`@${honey.name} hello`);
    await page.getByRole("button", { name: /Change agents$/ }).click();
    const menu = page.getByRole("dialog", {
      name: "Mention a member or agent",
    });
    const search = menu.getByRole("searchbox");
    await expect(search).toBeFocused();
    await page.keyboard.insertText(brain.name);
    await page.keyboard.press("Enter");
    // The tag joins the text while focus and typing stay in the search.
    await expect(composer).toHaveText(`@${honey.name} @${brain.name} hello`);
    await expect(search).toBeFocused();
    await page.keyboard.insertText("x");
    await expect(search).toHaveValue(`${brain.name}x`);
    await expect(composer).toHaveText(`@${honey.name} @${brain.name} hello`);
    // Tab out closes the menu and leaves focus where Tab put it.
    await search.focus();
    const outside = () =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active?.closest('[role="dialog"]')
          ? ""
          : (active?.getAttribute("aria-label") ?? "");
      });
    for (let i = 0; i < 20 && !(await outside()); i++)
      await page.keyboard.press("Tab");
    const destination = await outside();
    expect(destination).not.toBe("");
    await expect(menu).toBeHidden();
    // Base UI settles final focus a frame or two after the popup hides.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(await outside()).toBe(destination);
  });
});

// Real :focus-visible matching on a focused, briefly non-editable editor needs a
// browser. Solo admission disables the editor while its membership refreshes.
test.describe("Solo send focus", () => {
  test.use({ soloAgentNames: ["Owned Honey"] });
  test("sending keeps the keyboard focus ring off the briefly disabled editor", async ({
    page,
    app,
  }) => {
    let hold = false;
    let held = false;
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!hold || !filters.some((filter) => filter.kinds?.includes(39002)))
        return route.continue();
      held = true;
      await released;
      await route.continue().catch(() => {});
    });
    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Solo conversations" })
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    const [agent] = app.soloAgents;
    await sendOnlyTo(
      page,
      page.getByRole("button", { name: /Change agents$|^Choose agent$/ }),
      agent,
    );
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    // End is caret navigation, so the app's keyboard focus treatment is live.
    await composer.press("End");
    await page.keyboard.insertText("No ring while sending");
    await expect(page.locator("html")).toHaveAttribute(
      "data-keyboard-navigation",
      "",
    );
    hold = true;
    try {
      await composer.press("Enter");
      await expect.poll(() => held).toBe(true);
      await expect(composer).toHaveAttribute("aria-disabled", "true");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveCSS("outline-style", "none");
    } finally {
      hold = false;
      release();
    }
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await expect.poll(() => publications().length).toBe(1);
    await expect(composer).not.toHaveAttribute("aria-disabled");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveCSS("outline-style", "none");
  });
});
