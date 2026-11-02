import { pluginAction } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  openSettings,
  selectCommunity,
  settingsSections,
} from "./navigation.mjs";
test.use({ pairingFixture: true });
async function settings(page, app) {
  await open(page, app);
  await openSettings(page);
  await settingsSections(page)
    .getByRole("button", { name: "Pair mobile", exact: true })
    .click();
}
const phone = (page, status) =>
  page.evaluate((status) => {
    window.pairingFixture.status = status;
  }, status);
test("comparison code replaces QR, preserves leading zeros, and waits for phone completion", async ({
  page,
  app,
}) => {
  await settings(page, app);
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await phone(page, { phase: "code", code: "001234" });
  await expect(
    page.getByRole("heading", { name: "Verify the code on your phone" }),
  ).toBeVisible();
  await expect(page.getByText("001 234", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Codes match", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Pairing code" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pairing-code.png") });
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByText("001 234", { exact: true })).toBeVisible();
  const code = await page
    .getByRole("group", { name: "Pairing code" })
    .boundingBox();
  const steps = await page
    .getByRole("list", { name: "Pairing steps" })
    .boundingBox();
  expect(steps.y).toBeGreaterThan(code.y + code.height);
  await expect(
    page.getByRole("region", { name: "Pair mobile", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("pairing-code-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await phone(page, { phase: "transferring" });
  await expect(
    page.getByText("Finishing pairing on your phone…"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Phone paired" })).toHaveCount(
    0,
  );
  await phone(page, { phase: "complete" });
  await expect(
    page.getByRole("heading", { name: "Phone paired" }),
  ).toBeVisible();
});
test("phone confirmation, retry after expiry, and leaving Settings cancel the session", async ({
  page,
  app,
}) => {
  await settings(page, app);
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await phone(page, { phase: "code", code: "654321" });
  await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.pairingFixture.calls.filter((c) => c.action === "confirm")
            .length,
      ),
    )
    .toBe(1);
  await phone(page, {
    phase: "error",
    message: "Pairing expired. Create a new code and try again.",
  });
  await expect(page.getByRole("alert")).toContainText("Pairing expired");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await settingsSections(page)
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.pairingFixture.calls.at(-1)?.action))
    .toBe("cancel");
  await pluginAction(page, "Pair mobile").click();
  await expect(
    settingsSections(page).getByRole("button", {
      name: "Pair mobile",
      exact: true,
    }),
  ).toHaveCount(0);
});
test("leaving during native setup cancels its late result", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    window.pairingFixture.delay = true;
  });
  await openSettings(page);
  const sections = settingsSections(page);
  await sections
    .getByRole("button", { name: "Pair mobile", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.pairingFixture.release))
    .toBe(true);
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await page.evaluate(() => {
    window.pairingFixture.delay = false;
    window.pairingFixture.release();
  });
  await expect
    .poll(() => page.evaluate(() => window.pairingFixture.calls.at(-1)?.action))
    .toBe("cancel");
  await sections
    .getByRole("button", { name: "Pair mobile", exact: true })
    .click();
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
});

test("reloading a contributed Settings route waits for its plugin to activate", async ({
  page,
  app,
}) => {
  await settings(page, app);
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Pair mobile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pair mobile", exact: true }),
  ).toHaveCount(1);
});

test("expired QR refreshes automatically and leaving stops it", async ({
  page,
  app,
}) => {
  await settings(page, app);
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  const starts = () =>
    page.evaluate(
      () =>
        window.pairingFixture.calls.filter((c) => c.action === "start").length,
    );
  const before = await starts();
  await phone(page, { phase: "expired" });
  await expect.poll(starts).toBe(before + 1);
  await expect(
    page.getByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel pairing", exact: true }),
  ).toHaveCount(0);
  await settingsSections(page)
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.pairingFixture.calls.at(-1)?.action))
    .toBe("cancel");
  expect(await starts()).toBe(before + 1);
});

test("pairing positions stay fixed across states", async ({ page, app }) => {
  await settings(page, app);
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await phone(page, { phase: "connecting" });
    await expect(page.getByText("Creating pairing code…")).toBeVisible();
    const steps = page.getByRole("list", { name: "Pairing steps" });
    const before = await steps.boundingBox();
    await phone(page, {
      phase: "qr",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      uri: "nostrpair://fixture",
    });
    await expect(
      page.getByRole("button", { name: "Copy pairing code" }),
    ).toBeVisible();
    expect(await steps.boundingBox()).toEqual(before);
    await phone(page, { phase: "code", code: "001234" });
    await expect(page.getByText("001 234", { exact: true })).toBeVisible();
    expect(await steps.boundingBox()).toEqual(before);
    await phone(page, { phase: "transferring" });
    await expect(
      page.getByText("Finishing pairing on your phone…"),
    ).toBeVisible();
    expect(await steps.boundingBox()).toEqual(before);
  }
});

test("reduced motion removes QR animation styles", async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settings(page, app);
  await phone(page, {
    phase: "qr",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><style>circle { animation: reveal 58ms; }</style><circle r="1"/></svg>',
    uri: "nostrpair://fixture",
  });
  const qr = page.getByAltText("Scan this QR code with Buzz on your phone");
  await expect
    .poll(async () => decodeURIComponent(await qr.getAttribute("src")))
    .not.toContain("<style>");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => decodeURIComponent(await qr.getAttribute("src")))
    .toContain("<style>");
});

// The real shell, contributed route, and native-boundary fixture must work
// together; the no-membership and prefilled-origin cases stay in Vitest.
test("Personal space pairs with a manually entered community address", async ({
  page,
  app,
}) => {
  await open(page, app);
  await selectCommunity(page, "Personal space");
  await openSettings(page);
  const pairing = settingsSections(page).getByRole("button", {
    name: "Pair mobile",
    exact: true,
  });
  await pairing.click();
  await expect(pairing).toHaveAttribute("aria-current", "page");
  const qr = page.getByAltText("Scan this QR code with Buzz on your phone");
  // With no community selected, pairing waits for the address it needs.
  await expect(qr).toHaveCount(0);
  const address = page.getByLabel("Community address", { exact: true });
  await address.fill("https://community.example");
  await address.blur();
  await expect(qr).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.pairingFixture.calls.at(-1)?.action))
    .toBe("start");
});
