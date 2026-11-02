import { pauseClock } from "./clock.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("DM composer publishes empty scoped typing through the authenticated broker", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await page
    .locator('[data-sidebar-section="dms"] [data-channel-id="dm-peer"]')
    .click();
  const composer = page.getByRole("textbox", { name: /^Message / }).last();
  await expect(composer).toBeVisible();
  await expect.poll(() => app.relay.hasRoute("primary", "dm-peer")).toBe(true);
  await composer.click();
  await page.keyboard.type("typing diagnostic");
  await expect(composer).toHaveText("typing diagnostic");
  app.activity({ channel: "dm-peer", participant: 0 });
  const activity = page.getByRole("status", { name: "Conversation activity" });
  await expect(activity).toContainText("is typing");
  await expect.poll(() => app.report.typingPublications.length).toBe(1);
  const sent = app.report.typingPublications[0];
  expect(sent).toMatchObject({
    community: "primary",
    event: { kind: 20002, content: "", tags: [["h", "dm-peer"]] },
  });
  await testInfo.attach("publications.json", {
    body: JSON.stringify({
      publications: app.report.typingPublications,
      activity: await activity.allTextContents(),
    }),
    contentType: "application/json",
  });
  expect(app.report.typingPublications).toHaveLength(1);
});

test("DM receive lifecycle isolates participants, channels and threads and expires silence", async ({
  page,
  app,
}) => {
  await open(page, app);
  const dm = page.locator(
    '[data-sidebar-section="dms"] [data-channel-id="dm-peer"]',
  );
  await dm.click();
  await expect.poll(() => app.relay.hasRoute("primary", "dm-peer")).toBe(true);
  const activity = page.getByRole("status", { name: "Conversation activity" });
  const pulse = app.activity({ channel: "dm-peer", participant: 0 });
  expect(pulse.pubkey).toBe(app.participants[0]);
  await expect(activity).toContainText("Alice Fixture is typing");
  app.activity({ channel: "dm-peer", self: true });
  // A subsequent remote completion is a delivery barrier for the self pulse.
  app.activity({ channel: "dm-peer", participant: 0, kind: 9 });
  await expect(activity).toBeEmpty();
  // Use a distinct participant in the group DM, outside the prior quiet period.
  await page
    .locator('[data-sidebar-section="dms"] [data-channel-id="dm-group"]')
    .click();
  await expect.poll(() => app.relay.hasRoute("primary", "dm-group")).toBe(true);
  app.activity({ channel: "dm-group", root: "a".repeat(64), participant: 0 });
  app.activity({ channel: "dm-group", participant: 1 });
  await expect(activity).toContainText("is typing");
  await dm.click();
  await expect(activity).toBeEmpty();
  await page
    .locator('[data-sidebar-section="dms"] [data-channel-id="dm-group"]')
    .click();
  await expect(activity).toContainText("is typing");
  // Signed-time expiry must run without another event arriving.
  await page.clock.install();
  await pauseClock(page, 100);
  await page.clock.runFor(8_000);
  await expect(activity).toBeEmpty();
  await page.clock.setSystemTime(Date.now());
  app.activity({ channel: "dm-group", participant: 2 });
  await expect(activity).toContainText("is typing");
  app.relay.disconnect("primary");
  await expect(activity).toBeEmpty();
});

// This journey proves the actual app's retained composers and broker route each
// edit to its conversation. The timer/input matrix lives in mounted hook tests.
test("channel, thread and DM composers publish their own scope without publishing restored drafts", async ({
  page,
  app,
}) => {
  const typingSigns = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/sign")) return;
    const template = request.postDataJSON();
    if (template?.kind === 20002) typingSigns.push(template);
  });
  await open(page, app);
  const pulses = () => app.report.typingPublications;
  const type = async (input, text) => {
    await input.click();
    await page.keyboard.type(text);
  };
  expect(pulses()).toEqual([]);
  await type(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    "channel draft",
  );
  await expect.poll(() => pulses().length).toBe(1);
  expect(pulses()[0].event.tags).toEqual([["h", "alpha"]]);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  await type(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    "thread draft",
  );
  await expect.poll(() => pulses().length).toBe(2);
  expect(pulses()[1].event.tags).toEqual([
    ["h", "alpha"],
    ["e", root.id, "", "reply"],
  ]);
  await page
    .locator('[data-sidebar-section="dms"] [data-channel-id="dm-peer"]')
    .click();
  await type(
    page.getByRole("textbox", { name: /^Message / }).last(),
    "private draft",
  );
  await expect.poll(() => pulses().length).toBe(3);
  expect(pulses()[2].event.tags).toEqual([["h", "dm-peer"]]);
  const dmRoot = app.append("primary", "dm-peer", "Typing barrier root");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Beta", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page
    .locator('[data-sidebar-section="dms"] [data-channel-id="dm-peer"]')
    .click();
  await expect(
    page.getByRole("textbox", { name: /^Message / }).last(),
  ).toHaveText("private draft");
  // Keep the restored composer mounted while a concurrent thread completes its
  // pulse. Count signing attempts too, including a delayed or cancelled restore.
  const dmComposer = page.getByRole("textbox", { name: /^Message / }).last();
  const mounted = await dmComposer.elementHandle();
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${dmRoot.id}"]`,
  );
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await type(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    "publication barrier",
  );
  await expect
    .poll(() => pulses().at(-1)?.event.tags)
    .toEqual([
      ["h", "dm-peer"],
      ["e", dmRoot.id, "", "reply"],
    ]);
  expect(await mounted.evaluate((node) => node.isConnected)).toBe(true);
  await expect(dmComposer).toHaveText("private draft");
  expect(typingSigns).toHaveLength(4);
  expect(pulses()).toHaveLength(4);
  expect(pulses().every(({ event }) => event.content === "")).toBe(true);
  await expect(
    page.getByRole("status", { name: "Conversation activity" }),
  ).toHaveText(["", ""]);
  expect(app.report.publications).toEqual([]);
});
