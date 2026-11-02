import { generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const solo = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [solo, "beta"],
  channelNames: { [solo]: "Alpha", beta: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  dmLabels: true,
  historyCounts: { [solo]: 1, beta: 1 },
});

// Real paint geometry: DOM emulators cannot detect padding or baseline drift.
test("Team and Solo working badges share the painted row inset", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  for (const channelId of [solo, "beta"]) {
    app.observer(
      {
        kind: "turn_liveness",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId,
        sessionId: "S",
        turnId: channelId,
      },
      generateSecretKey(),
    );
  }
  const soloRow = page.locator(`[data-solo-menu-id="${solo}"]`);
  const teamRow = page
    .locator("[data-channel-sidebar-row]")
    .filter({ has: page.locator('[data-channel-id="beta"]') });
  for (const row of [soloRow, teamRow]) {
    await expect(row.locator("[data-channel-working]")).toBeVisible();
  }
  await page.mouse.move(0, 0);
  for (const [mode, width, fontSize] of [
    ["light", 1440, ""],
    ["dark", 900, "larger"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    for (const row of [soloRow, teamRow]) {
      await expect
        .poll(() =>
          row.evaluate((element) => {
            const marker = element
              .querySelector("[data-channel-working]")
              .getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            // The end token is a calc expression; resolve it through the painted pseudo-element.
            const fillEnd = parseFloat(
              getComputedStyle(element, "::before").right,
            );
            const root = parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            );
            return {
              center:
                Math.round(
                  (marker.y + marker.height / 2 - rect.y - rect.height / 2) *
                    100,
                ) / 100,
              inset:
                Math.round(
                  ((rect.right - fillEnd - marker.right) / root) * 100,
                ) / 100,
            };
          }),
        )
        .toEqual({ center: 0, inset: 0.5 });
    }
  }
});

test("a presence badge preserves the sidebar avatar center and header insets", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const row = page.locator('button[data-channel-id="dm-peer"]');
  await row.click();
  await expect
    .poll(() =>
      app.report.presenceSnapshots.some((snapshot) =>
        snapshot.filter.authors.includes(app.participants[0]),
      ),
    )
    .toBe(true);
  // Snapshot admission precedes the separate live presence REQ.
  await expect
    .poll(() => app.relay.hasPresenceRoute("primary", app.participants[0]))
    .toBe(true);
  app.presence("away");
  const avatar = row.locator(".buzz-avatar-status");
  await expect(avatar).toHaveAttribute("data-status", "away");
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Open profile for Alice Fixture/ })
    .click();
  const headers = page.locator("header.panel-header");
  await expect(headers).toHaveCount(2);
  for (const [mode, fontSize] of [
    ["light", ""],
    ["dark", "larger"],
  ]) {
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    await expect
      .poll(() =>
        avatar.evaluate((element) => {
          const row = element
            .closest("[data-channel-sidebar-row]")
            .getBoundingClientRect();
          const image = element
            .querySelector(".buzz-avatar")
            .getBoundingClientRect();
          const dot = element
            .querySelector(".buzz-avatar-status-dot")
            .getBoundingClientRect();
          return {
            offset: image.y + image.height / 2 - row.y - row.height / 2,
            square: dot.width === dot.height,
          };
        }),
      )
      .toEqual({ offset: 0, square: true });
    for (const header of await headers.all()) {
      await expect
        .poll(() =>
          header.evaluate((element) => {
            const frame = element.getBoundingClientRect();
            const tab = element
              .querySelector('[role="tab"]')
              .getBoundingClientRect();
            const outer = element.closest(".panel[data-joined]");
            const bandTop = outer.getBoundingClientRect().top;
            const separator = parseFloat(
              getComputedStyle(element, "::after").height,
            );
            const bandBottom = frame.bottom - separator;
            return Math.abs(tab.top - bandTop - (bandBottom - tab.bottom));
          }),
        )
        .toBeLessThan(1);
    }
  }
  await openChannelDetails(page);
  const detailHeader = headers.last();
  await expect(detailHeader.getByRole("tab")).toHaveCount(2);
  let fittingInset;
  // Keep the desktop split visible; narrower windows use a fixed-width overlay.
  for (const [key, overflowing] of [
    ["End", false],
    ["Home", true],
  ]) {
    await page
      .getByRole("separator", {
        name: "Resize main and secondary panels",
        exact: true,
      })
      .press(key);
    const strip = detailHeader.locator(".buzz-tabs-list");
    await expect
      .poll(() => strip.evaluate((e) => e.scrollWidth > e.clientWidth))
      .toBe(overflowing);
    const inset = await detailHeader.evaluate((e) => {
      const frame = e.getBoundingClientRect();
      return (
        e.querySelector('[role="tab"]').getBoundingClientRect().top - frame.top
      );
    });
    if (fittingInset === undefined) fittingInset = inset;
    expect(inset).toBe(fittingInset);
  }
});
