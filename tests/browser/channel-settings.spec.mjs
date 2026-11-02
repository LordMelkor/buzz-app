import { openChannelDetails } from "./channel-details.mjs";
import { openPage, settlePanelMotion } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test("channel settings owns its responsive side panel and returns keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("tab", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const workspace = page.locator("[data-panel-workspace]");
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await openChannelDetails(page);
  await expect(panel).toBeVisible();
  // Joined panels share the workspace frame and keep a token-based header divider.
  const tokens = await page.addStyleTag({
    content: `:root, :root[data-color-mode] {
      --surface-panel: rgb(23, 45, 67);
      --border-standard: rgb(45, 67, 89);
      --radius-panel: 19px;
    }`,
  });
  try {
    await expect(panel).toHaveCSS("background-color", "rgb(23, 45, 67)");
    await expect(panel).toHaveCSS("border-top-width", "0px");
    await expect(panel).toHaveCSS("border-radius", "0px");
    expect(
      await workspace
        .locator("header.panel-header")
        .evaluate(
          (header) => getComputedStyle(header, "::after").backgroundColor,
        ),
    ).toBe("rgb(45, 67, 89)");
  } finally {
    await tokens.evaluate((node) => node.remove());
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const channelTab = conversation.getByRole("tab", {
    name: "Alpha",
    exact: true,
  });
  await channelTab.hover();
  await expect(channelTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(channelTab).toHaveCSS("cursor", "default");
  const settingsTab = workspace.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settingsTab).toHaveClass(/navigation-item/);
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await workspace
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(workspace).toBeHidden();
  await openChannelDetails(page);
  await expect(settingsTab).toBeFocused();
  expect(
    await settingsTab.evaluate(
      (tab) =>
        tab.parentElement.getBoundingClientRect().width /
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ).toBeLessThanOrEqual(12);
  const close = workspace.getByRole("button", {
    name: "Close Channel settings tab",
  });
  await expect(
    workspace.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await panel.getByText("Diagnostics", { exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeVisible();
  const conversationBox = await conversation.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(
    conversationBox.x + conversationBox.width,
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await openChannelDetails(page);
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(panel).toBeVisible();
  await settlePanelMotion(page);
  await close.click();
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await openChannelDetails(page);
  await expect(
    workspace.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  // Focus moves before the panel finishes entering; wait for its visible geometry.
  await expect(panel).toBeInViewport({ ratio: 1 });
  const narrow = await panel.boundingBox();
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(600);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(800);
  await settlePanelMotion(page);
  await close.click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await openChannelDetails(page);
  await expect(panel).toBeVisible();
  const messages = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Direct messages$/ });
  await messages.hover();
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
});
