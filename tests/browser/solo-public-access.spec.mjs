import { test, expect } from "./fixture.mjs";
import { generateSecretKey } from "nostr-tools";
import {
  expectMessageActionsHidden,
  hoverMessage,
} from "./message-actions.mjs";

const own = "33333333-3333-4333-8333-333333333333";
const shared = "11111111-1111-4111-8111-111111111111";
const presentations = [
  { mode: "dark", width: 1440, scale: 1 },
  { mode: "light", width: 1440, scale: 1 },
  { mode: "dark", width: 390, scale: 1.5 },
  { mode: "light", width: 390, scale: 1.5 },
];

test.use({ productionBroker: true, channelLifecycle: true });

async function openChat(page, app, channelId) {
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  await expect(
    page.getByRole("article", { name: "Conversation", exact: true }),
  ).toBeVisible();
}

async function present(page, { mode, width, scale }) {
  await page.setViewportSize({ width, height: width === 390 ? 720 : 950 });
  await page.evaluate(
    ({ mode, scale }) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
      localStorage.setItem("buzz-accent.v1", "cobalt");
    },
    { mode, scale },
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
  await expect(page.locator("html")).toHaveCSS(
    "--buzz-text-scale",
    String(scale),
  );
}

async function capture(surface, info, name) {
  if (info.project.name === "chromium")
    await surface.screenshot({ path: info.outputPath(`${name}.png`) });
}

// These preserve the two browser journeys: actual routing, signed discovery,
// broker save/readback, focus and responsive overlays. Role matrices stay in Vitest.
test.describe("owner", () => {
  test.use({
    channelIds: [own],
    channelNames: { [own]: "Release planning" },
    soloChannels: [own],
    ownSoloChannels: [own],
    historyCounts: { [own]: 2 },
  });
  test("omits Public, retains View only after reload, and restores privacy", async ({
    page,
    app,
  }, info) => {
    await openChat(page, app, own);
    const row = page.locator(`[data-solo-channel-id="${own}"]`);
    const access = page
      .getByRole("button", { name: "Share access", exact: true })
      .last();
    const dialog = page.getByRole("dialog", {
      name: "Share access",
      exact: true,
    });
    const audience = dialog.getByRole("combobox", { name: "General access" });
    const openAccess = async () => {
      // Cached startup renders Share access too. Its local dialog is replaced
      // with the live session; Chat actions exists only on the live header.
      await expect(
        page.getByRole("button", { name: "Chat actions", exact: true }),
      ).toBeVisible();
      await access.click();
    };
    const confirm = page.getByRole("alertdialog", {
      name: "Change general access?",
    });
    let saves = 0;
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      await present(page, presentation);
      if (presentation.width === 1440) await expect(row).toBeVisible();
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("Private");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      // General access now scrolls with the member list, including at enlarged text.
      await audience.scrollIntoViewIfNeeded();
      await expect(audience).toBeInViewport({ ratio: 1 });
      await capture(dialog, info, `SOLO_DROPDOWN_PRIVATE_${suffix}`);
      await audience.focus();
      await audience.press("Enter");
      await expect(page.getByRole("option")).toHaveCount(2);
      await expect(
        page.getByRole("option", { name: "Public", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("option", { name: "Private", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("option", { name: "View only", exact: true }),
      ).toBeVisible();
      // The popup owns the transition; the nested list has no animations.
      await expect(page.locator(".buzz-select-popup")).toHaveCSS(
        "filter",
        "blur(0px)",
      );
      await expect(page.locator(".buzz-select-popup")).toHaveCSS(
        "opacity",
        "1",
      );
      // At 150% text the shared popup scrolls to the selected Private item.
      // Verify View only is reachable before capturing it.
      const viewOnlyOption = page.getByRole("option", {
        name: "View only",
        exact: true,
      });
      await viewOnlyOption.scrollIntoViewIfNeeded();
      await expect(viewOnlyOption).toBeInViewport({ ratio: 1 });
      await capture(page, info, `SOLO_DROPDOWN_OPTIONS_${suffix}`);
      await page.keyboard.press("Home");
      await expect(viewOnlyOption).toBeFocused();
      await expect(confirm).toHaveCount(0);
      expect(app.report.detailsPublications?.length ?? 0).toBe(saves);
      await page.keyboard.press("Enter");
      await expect(confirm).toHaveAccessibleDescription(
        "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
      );
      await expect(
        confirm.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      await capture(confirm, info, `SOLO_VIEW_ONLY_CONFIRMATION_${suffix}`);
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      expect(app.report.detailsPublications?.length ?? 0).toBe(saves);
      await audience.click();
      await page
        .getByRole("option", { name: "View only", exact: true })
        .click();
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await confirm
        .getByRole("button", { name: "Change access", exact: true })
        .click();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("View only");
      expect(app.report.detailsPublications).toHaveLength(++saves);
      const opened = app.report.detailsPublications.at(-1);
      expect(opened.tags).toContainEqual(["visibility", "open"]);
      if (saves === 1)
        expect(opened.tags).toContainEqual(["join_role", "guest"]);
      await expect(dialog.getByRole("combobox")).toHaveCount(1);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await capture(dialog, info, `SOLO_DROPDOWN_VIEW_ONLY_${suffix}`);
      await page.keyboard.press("Escape");
      await page.reload();
      await openAccess();
      await expect(audience).toHaveText("View only");
      await expect(audience).toBeEnabled();
      await audience.click();
      await expect(
        page.getByRole("option", { name: "Public", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toContainText(
        "Only chat members will have access.",
      );
      await confirm
        .getByRole("button", { name: "Change access", exact: true })
        .click();
      await expect(audience).toHaveText("Private");
      await expect(audience).toBeEnabled();
      expect(app.report.detailsPublications).toHaveLength(++saves);
      expect(app.report.detailsPublications.at(-1).tags).toContainEqual([
        "visibility",
        "private",
      ]);
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
    }
    // The longer conditional descriptions need real modal geometry and focus
    // coverage. Guest/status matrices remain in the component/session tests.
    const guest = app.serveProfile(generateSecretKey(), {
      name: "Aria viewer",
    });
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!filters.some((filter) => filter.kinds?.includes(39002)))
        return route.continue();
      const response = await route.fetch();
      const events = await response.json();
      await route.fulfill({
        json: events.map((event) =>
          event.kind === 39002 &&
          event.tags.some(([key, value]) => key === "d" && value === own)
            ? app.signRelay({
                ...event,
                // A changed signed roster must supersede the startup version.
                created_at: event.created_at + 1,
                tags: [...event.tags, ["p", guest.pubkey, "", "guest"]],
              })
            : event,
        ),
      });
    });
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      app.setChannelMetadata(own, [
        ["t", "stream"],
        ["t", "buzz.solo"],
        ["P", app.viewer],
        ["name", "Release planning"],
        ["public"],
        ["join_role", "guest"],
      ]);
      await present(page, presentation);
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("View only");
      await expect(
        dialog.getByText("Viewing only", { exact: true }),
      ).toBeVisible();
      await audience.click();
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toHaveAccessibleDescription(
        "Only chat members will have access. People who joined while it was View only are members and keep reading until you remove them in People.",
      );
      await expect(
        confirm.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(confirm, info, `SOLO_PRIVATE_GUEST_CONFIRMATION_${suffix}`);
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await page.keyboard.press("Escape");
      app.setChannelMetadata(own, [
        ["t", "stream"],
        ["t", "buzz.solo"],
        ["P", app.viewer],
        ["name", "Release planning"],
        ["public"],
        ["join_role", "member"],
      ]);
      await page.reload();
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("Public (existing)");
      await audience.click();
      await page
        .getByRole("option", { name: "View only", exact: true })
        .click();
      await expect(confirm).toHaveAccessibleDescription(
        "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions. People already in the chat keep their access.",
      );
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(
        confirm,
        info,
        `SOLO_EXISTING_PUBLIC_CONFIRMATION_${suffix}`,
      );
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await audience.click();
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toHaveAccessibleDescription(
        "Only chat members will have access. People who already joined remain members and keep their access until you remove them in People.",
      );
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(
        confirm,
        info,
        `SOLO_PUBLIC_PRIVATE_CONFIRMATION_${suffix}`,
      );
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await page.keyboard.press("Escape");
    }
    expect(app.report.detailsPublications.map(({ kind }) => kind)).toEqual(
      Array(8).fill(9002),
    );
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.publications).toEqual([]);
  });
});

test.describe("visitor", () => {
  test.use({
    guestPermalinks: true,
    lifecycleRole: "nonmember",
    historyCounts: { [shared]: 2 },
  });
  test("reads View only without joining and loses access when the chat becomes Private", async ({
    page,
    app,
  }, info) => {
    const tags = [
      ["name", "Release planning"],
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["P", "a".repeat(64)],
      ["join_role", "guest"],
    ];
    app.setChannelMetadata(shared, [...tags, ["public"]]);
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("Release planning");
    const result = page
      .locator("[data-search-result]")
      .filter({ hasText: "View-only chat" });
    await expect(result).toContainText("Release planning");
    await result.click();
    const article = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      await present(page, presentation);
      const message = article.locator("[data-message-id]").last();
      await expect(message).toBeVisible();
      await expect(
        page.getByText("This chat is read-only", { exact: true }),
      ).toBeVisible();
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Join", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-solo-channel-id="${shared}"]`),
      ).toHaveCount(0);
      await hoverMessage(message);
      await message
        .getByRole("button", { name: "More message actions", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "React", exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      const searchButton = page.getByRole("button", {
        name: "Search Buzz",
        exact: true,
      });
      await searchButton.focus();
      await expect(searchButton).toBeFocused();
      await searchButton.evaluate((button) => button.blur());
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expectMessageActionsHidden(
        message.getByRole("group", {
          name: "Message actions",
          exact: true,
          includeHidden: true,
        }),
      );
      await capture(article, info, `SOLO_DROPDOWN_VISITOR_${suffix}`);
      await page
        .getByRole("button", { name: /^Share access/ })
        .last()
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Chat access",
        exact: true,
      });
      await expect(
        dialog.getByText("Anyone in the community can read."),
      ).toBeVisible();
      await expect(
        dialog.getByText("Viewing only. Ask an owner or admin to participate."),
      ).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "General access" }),
      ).toHaveCount(0);
      await capture(dialog, info, `SOLO_DROPDOWN_VISITOR_ACCESS_${suffix}`);
      await page.keyboard.press("Escape");
    }
    app.setChannelMetadata(shared, [...tags, ["private"]]);
    await page.reload();
    await expect(article.locator("[data-message-id]")).toHaveCount(0);
    app.setChannelMetadata(shared, [
      ...tags.filter(([name]) => name !== "join_role"),
      ["join_role", "member"],
      ["public"],
    ]);
    await page.reload();
    await expect(article.locator("[data-message-id]").last()).toBeVisible();
    await page
      .getByRole("button", { name: /^Share access/ })
      .last()
      .click();
    const existingAccess = page.getByRole("dialog", {
      name: "Share access",
      exact: true,
    });
    await expect(
      existingAccess.getByRole("region", { name: "Member list" }),
    ).toHaveAttribute("data-refreshing", "false");
    await expect(existingAccess.getByRole("alert")).toHaveCount(0);
    await expect(
      existingAccess.getByRole("region", { name: "People", exact: true }),
    ).toBeVisible();
    await expect(
      existingAccess.getByRole("region", { name: "General access" }),
    ).toContainText("New people can participate.");
    await capture(
      existingAccess,
      info,
      "SOLO_PUBLIC_EXISTING_VISITOR_light_390",
    );
    expect(app.report.detailsPublications ?? []).toEqual([]);
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.publications).toEqual([]);
  });
});
