import { test, expect } from "./fixture.mjs";
import { generateSecretKey } from "nostr-tools";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const channel = "11111111-1111-4111-8111-111111111111";
test.use({
  productionBroker: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Release planning" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [channel]: 2, [chat]: 2 },
});

// Browser boundary: restored IndexedDB intent, the real Outbox Retry routing,
// broker reads and signed roster readback must agree across a page reload.
// Expiry/role/concurrency matrices stay in the colocated unit tests.
test("Outbox Retry replaces an expired unapplied Solo invitation without replaying it", async ({
  page,
  app,
}, info) => {
  const now = Date.now();
  await page.clock.setFixedTime(new Date(now));
  const person = app.serveProfile(generateSecretKey(), { name: "Aria" });
  const original = app.sign({
    kind: 9000,
    created_at: Math.floor(now / 1000) - 899,
    content: "",
    tags: [
      ["h", chat],
      ["p", person.pubkey],
    ],
  });
  const recovery = { key: `member-add:${chat}:${person.pubkey}`, value: "1" };
  await page.addInitScript(
    ({ scope, original, recovery }) => {
      localStorage.setItem(
        `buzz-outbox-v1:${scope}`,
        JSON.stringify([
          { event: original, signed: original, delivery: "unknown", recovery },
        ]),
      );
    },
    { scope: `https://primary.example:${app.viewer}`, original, recovery },
  );
  const publications = [];
  let joined = false;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind !== 9000) return route.continue();
    expect(event.id).not.toBe(original.id);
    expect(event.tags).toContainEqual(["role", "member"]);
    publications.push(event);
    joined = true;
    await route.fulfill({
      json: { accepted: true, event_id: event.id, message: "" },
    });
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!joined || !filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === chat)
          ? app.signRelay({
              ...event,
              created_at: event.created_at + 1,
              tags: [...event.tags, ["p", person.pubkey, "", "member"]],
            })
          : event,
      ),
    });
  });
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const summary = panel.locator("summary").filter({ hasText: /^Outbox ·/ });
  const outbox = summary.locator("..");
  for (const mode of ["dark", "light"]) {
    await page.goto(app.origin);
    await page.evaluate(
      (mode) => localStorage.setItem("buzz-appearance.v1", mode),
      mode,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await openPage(page, "Messages");
    await page
      .getByRole("button", { name: "Project updates", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Project updates",
        exact: true,
      }),
    ).toBeVisible();
    await openChannelDetails(page);
    await panel.getByText("Diagnostics", { exact: true }).click();
    await summary.click();
    await expect(summary).toHaveText("Outbox · 1 items");
    await outbox.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(outbox.getByRole("alert")).toContainText(
      "15-minute delivery window",
    );
    expect(publications).toHaveLength(0);
    if (info.project.name === "chromium")
      await outbox.screenshot({
        path: info.outputPath(`SOLO_LEGACY_WAIT_${mode}.png`),
      });
  }
  await page.clock.setFixedTime(new Date(now + 2000));
  await outbox.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(summary).toHaveText("Outbox · 0 items");
  await expect(outbox.getByRole("alert")).toHaveCount(0);
  expect(publications).toHaveLength(1);
  await page.reload();
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "Project updates", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Project updates",
      exact: true,
    }),
  ).toBeVisible();
  await openChannelDetails(page);
  await expect(summary).toHaveText("Outbox · 0 items");
  expect(publications).toHaveLength(1);
});
