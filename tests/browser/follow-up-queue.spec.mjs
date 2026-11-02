import { test, expect } from "./fixture.mjs";
import { openPage, selectSettingsSection, sendOnlyTo } from "./navigation.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const agent =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
test.use({
  productionBroker: true,
  localAgentActivity: true,
  channelIds: [chat],
  channelNames: { [chat]: "Alpha" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  sessionMembers: { [chat]: [agent] },
  historyCounts: { [chat]: 1 },
});

// Real host wiring, keyboard send, queued-row geometry and native agent completion
// projection. External work and relay identities are controlled test fixtures.
test("Solo queues follow-ups, keeps typing intact, and offers Send now", async ({
  page,
  app,
}, testInfo) => {
  const { editor, first } = await startWorkingAgent(page, app);
  await editor.press("End");
  await editor.pressSequentially("Queued follow-up");
  await editor.press("Enter");
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue).toContainText("Queued follow-up");
  await editor.press("End");
  await editor.pressSequentially("Keep typing");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const button = queue.getByRole("button", { name: "Send", exact: true });
      await expect(button).toBeVisible();
      const contrast = () =>
        button.evaluate((element) => {
          const luminance = (color) => {
            const channels = color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number)
              .map((channel) => {
                const value = channel / 255;
                return value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4;
              });
            return (
              channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
            );
          };
          const style = getComputedStyle(element);
          const foreground = luminance(style.color),
            background = luminance(style.backgroundColor);
          return (
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05)
          );
        });
      // Approved queue-only design exception: resting text uses the quiet
      // control token (about 3.62:1 in light mode), not WCAG AA text contrast.
      // Keep that exact treatment covered; interactive states must meet 4.5:1.
      await editor.focus();
      await page.mouse.move(0, 0);
      const quietColor = await button.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--text-quiet-control)";
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(button).toHaveCSS("color", quietColor);
      await button.hover();
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await queue
        .getByRole("button", { name: "Remove queued message" })
        .focus();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
      await editor.focus();
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const queueBox = await queue.boundingBox();
      const composerBox = await editor
        .locator("xpath=ancestor::form")
        .boundingBox();
      expect(queueBox.x).toBe(composerBox.x);
      expect(queueBox.width).toBe(composerBox.width);
      expect(composerBox.y - queueBox.y - queueBox.height).toBe(8);
      const trashBox = await queue
        .getByRole("button", { name: "Remove queued message" })
        .boundingBox();
      expect(trashBox.x + trashBox.width).toBeLessThan(box.x);
      expect(trashBox.height).toBe(box.height);
      await page.screenshot({
        path: testInfo.outputPath(`queue-${colorScheme}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("queue-enlarged.png") });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.evaluate((id) => window.localAgentFixture.finish(id, true), first);
  await expect(queue).toHaveCount(0);
  await expect(editor).toContainText("Keep typing");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await editor.press("Enter");
  await expect(queue).toContainText("Keep typing");
  await editor.pressSequentially("Next keyboard send");
  await editor.press("Enter");
  await expect(queue).toContainText("Next keyboard send");
  await queue
    .getByRole("button", { name: "Send", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCount(1);
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await editor.pressSequentially("Remove this follow-up");
  await editor.press("Enter");
  await expect(queue).toContainText("Remove this follow-up");
  await queue.getByRole("button", { name: "Remove queued message" }).focus();
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 9).length,
    )
    .toBeGreaterThanOrEqual(3);
});

async function startWorkingAgent(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Appearance", "Appearance");
  const preference = page.getByRole("combobox", { name: "Follow-up behavior" });
  await expect(preference).toContainText("Send immediately");
  await preference.click();
  await page.getByRole("option", { name: "Queue", exact: true }).click();
  await page
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeHidden();
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Solo conversations" })
    .locator(`[data-solo-channel-id="${chat}"]`)
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const editor = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  // Agents-only Solo chats address agents from the composer's pill.
  await sendOnlyTo(
    page,
    page.getByRole("button", { name: /Change agents$|^Choose agent$/ }),
    { name: "Local tester", pubkey: agent },
  );
  await editor.press("End");
  await editor.pressSequentially("First request");
  await editor.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const first = await page.evaluate(
    () => window.localAgentFixture.pending()[0],
  );
  return { editor, first };
}

// Browser-only: pointer modality, computed visibility and native focus handoff.
test("queue focus survives preview release and pointer removal", async ({
  page,
  app,
}) => {
  const { editor, first } = await startWorkingAgent(page, app);
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await editor.press("End");
  // Seed long content in one input event; this journey tests focus, not typing throughput.
  await page.keyboard.insertText("A long queued request ".repeat(30));
  await editor.press("Enter");
  const preview = queue.locator('[data-queue-action="preview"]');
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  await preview.focus();
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("aria-expanded", "true");
  await page.evaluate((id) => window.localAgentFixture.finish(id, true), first);
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await editor.press("End");
  await editor.pressSequentially("Keep this row");
  await editor.press("Enter");
  // Admission is asynchronous: settle the first submission before typing into
  // the draft it clears, then establish both rows before testing removal.
  await expect(queue).toContainText("Keep this row");
  await expect(editor).not.toContainText("Keep this row");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.press("End");
  await editor.pressSequentially("Remove last row");
  await editor.press("Enter");
  await expect(queue).toContainText("Remove last row");
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const remove = queue.getByRole("button", { name: "Remove queued message" });
  await expect(remove).toHaveCount(2);
  await queue.getByRole("listitem").last().hover();
  // WebKit does not focus clicked buttons; focus explicitly to cover the same
  // pointer-modality handoff on both engines.
  await remove.last().focus();
  await remove.last().click();
  await page.mouse.move(0, 0);
  await expect(remove).toHaveCount(1);
  await expect(remove).toBeFocused();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await expect(remove).toHaveCSS("opacity", "1");
  await expect(remove).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
});
