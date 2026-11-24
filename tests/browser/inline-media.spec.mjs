import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { clickRow, open } from "./timeline.mjs";

// Browser-only: a media sheet is laid out around a real composer across the
// workspace, only real history proves it adds no step to it, and the intro's
// steps anchor to the sheet's settled header.
test.use({ threadPlacement: "inline" });

const photo = [
  ["imeta", "url https://primary.example/media/photo.png", "m image/png"],
];
const mediaSheet = (page) =>
  page.locator('[data-details-sheet-surface][data-height="stable"]');

test("media opens in a sheet over its view without a history step", async ({
  page,
  app,
  context,
}) => {
  await context.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Inline media",
    true,
    true,
    undefined,
    undefined,
    photo,
  );
  app.append("primary", "alpha", "Media comment", false, true, event.id);
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  const steps = await page.evaluate(() => history.length);
  await clickRow(
    page,
    row.getByRole("link", { name: "Open image attachment", exact: true }),
  );
  const sheet = mediaSheet(page);
  await expect(sheet).toBeVisible();
  const comments = sheet.getByRole("complementary", { name: "Media comments" });
  await expect(
    comments.getByText("Media comment", { exact: true }),
  ).toBeVisible();
  await expect(
    comments.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeVisible();
  // It covers the conversation's composer, which stays mounted beneath it.
  const composer = page.getByRole("form", { name: /^Send a message to/ });
  const [outer, inner] = [
    await sheet.boundingBox(),
    await composer.boundingBox(),
  ];
  expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  expect(await page.evaluate(() => history.length)).toBe(steps);
  await sheet
    .getByRole("button", { name: "Close media viewer", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(steps);
});

test.describe("Intro", () => {
  test.use({
    threadIntro: true,
    productionBroker: true,
    readState: true,
    threadUnread: true,
    historyCounts: { alpha: 20, beta: 1 },
  });

  test("the first inline thread introduces itself once", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const viewThread = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await clickRow(page, viewThread);
    const first = page.locator('[data-inline-thread-intro="1"]');
    await expect(first).toBeVisible();
    await expect(first).toContainText("Threads now open inline");
    await first.getByRole("button", { name: "Next" }).click();
    const second = page.locator('[data-inline-thread-intro="2"]');
    await expect(second).toBeVisible();
    await expect(
      second.getByRole("switch", { name: "Open threads inline" }),
    ).toBeChecked();
    await second.getByRole("button", { name: "Got it" }).click();
    await expect(second).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Thread", exact: true }),
    ).toHaveCount(0);
    await clickRow(page, viewThread);
    await expect(
      page.getByRole("heading", { name: "Thread", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-inline-thread-intro]")).toHaveCount(0);
  });
});
