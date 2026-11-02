import { test, expect } from "./source-fixture.mjs";

async function expectWebsiteVisible(page, since) {
  const previous = await page.evaluate(
    () => window.appsPanelCalls.presentations.length,
  );
  // Force and observe a completed host presentation pass after placement has
  // settled, rather than asserting that no hide call has happened yet.
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.presentations.length))
    .toBeGreaterThan(previous);
  expect(
    await page.evaluate(
      (since) =>
        window.appsPanelCalls.presentations
          .slice(since)
          .every((entry) => entry.visible),
      since,
    ),
  ).toBe(true);
}

// Browser integration: the real Cordis component proxy must not remount the
// registered Apps panel as sibling tabs change. Native guest I/O is substituted.
test("Apps keeps its last native URL after Cordis rerenders and pool eviction", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/apps-panel.html");
  const address = () =>
    page
      .getByRole("region", { name: "App 1 pane" })
      .getByRole("textbox", { name: "Address" });
  const current = "https://app1--bpsites.apps.builderlabstaging.xyz/second";
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.attached.length))
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => window.appsPanelCalls.attached[0]?.authenticated),
    )
    .toBe(true);
  await address().fill(current);
  await address().press("Enter");
  // This observed address comes from a completed native status poll.
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          window.appsPanelCalls.statuses.some(
            (entry) => entry.id === "guest-1" && entry.url === url,
          ),
        current,
      ),
    )
    .toBe(true);
  await expect(address()).toHaveValue(current);
  for (const index of [2, 3, 4, 5]) {
    await page
      .getByRole("button", { name: `Show app ${index}`, exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.appsPanelCalls.attached.length))
      .toBe(index);
  }
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.detached))
    .toContain("guest-1");
  await page.getByRole("button", { name: "Show app 1", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.attached.at(-1)?.url))
    .toBe(current);
  await expect(address()).toHaveValue(current);
});

// Real tooltip placement must fit the conversation pane; DOM emulators cannot
// prove that its text avoids a neighboring native browser's paint rectangle.
for (const mode of ["light", "dark"]) {
  for (const width of [260, 420, 720]) {
    test(`hover hints stay readable beside an app (${mode}, ${width}px)`, async ({
      page,
    }) => {
      await page.goto(`/tests/fixtures/apps-panel.html?pane-width=${width}`);
      await page.locator("html").evaluate((element, mode) => {
        element.dataset.colorMode = mode;
        element.style.colorScheme = mode;
      }, mode);
      await expect
        .poll(() =>
          page.evaluate(
            () => window.appsPanelCalls.presentations.at(-1)?.visible,
          ),
        )
        .toBe(true);
      const baseline = await page.evaluate(
        () => window.appsPanelCalls.presentations.length,
      );
      for (const name of ["Model and effort", "Send message"]) {
        const button = page.getByRole("button", { name, exact: true });
        await button.hover();
        const hint = page.getByRole("tooltip");
        await expect(hint).toBeVisible();
        await expect
          .poll(() =>
            hint.evaluate((element) => {
              const hint = element.getBoundingClientRect();
              const pane = document
                .querySelector("[data-main-workspace]")
                .getBoundingClientRect();
              return (
                hint.left >= pane.left &&
                hint.right <= pane.right &&
                element.scrollWidth <= element.clientWidth
              );
            }),
          )
          .toBe(true);
        await expectWebsiteVisible(page, baseline);
        await page.mouse.move(0, 0);
        await expect(hint).toHaveCount(0);
      }
      const avatar = page.getByRole("button", { name: "nthilly avatar" });
      await avatar.hover();
      const preview = page.getByRole("dialog", {
        name: "nthilly profile preview",
      });
      await expect(preview).toBeVisible();
      await expect
        .poll(() =>
          preview.evaluate((element) => {
            const card = element.getBoundingClientRect();
            const pane = document
              .querySelector("[data-main-workspace]")
              .getBoundingClientRect();
            return card.left >= pane.left && card.right <= pane.right;
          }),
        )
        .toBe(true);
      await expectWebsiteVisible(page, baseline);
      await avatar.focus();
      await avatar.press("Tab");
      await expect(
        preview.getByRole("button", { name: "View profile" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.appsPanelCalls.profilesOpened))
        .toEqual(["buzz://profile/nthilly"]);
      await expect(preview).toHaveCount(0);
    });
  }
}
