import { pauseClock } from "./clock.mjs";
import { test, expect } from "./source-fixture.mjs";
import { fileURLToPath } from "node:url";

const artworkPath = fileURLToPath(
  new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
);

test("shared avatars defer offscreen artwork, omit the referrer and recover from failure", async ({
  page,
}) => {
  // Time flows normally until the spec pauses it around the same-source retry.
  await page.clock.install();
  const requests = [];
  await page.route("https://images.example/avatar.png", async (route) => {
    requests.push(route.request().headers());
    await route.fulfill({ path: artworkPath, contentType: "image/png" });
  });
  let sentinelRequests = 0;
  await page.route("https://images.example/sentinel.png", (route) => {
    sentinelRequests++;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/tests/fixtures/avatar-loading.html");
  const region = page.getByRole("region", { name: "Avatars", exact: true });
  await expect(region).not.toBeInViewport();
  const avatar = region.getByRole("img", { name: "A Brain identity" });
  const image = avatar.locator("img");
  // The offscreen avatar must exist with its source before the barrier can
  // say anything about whether it was deferred.
  await expect(image).toHaveAttribute(
    "src",
    "https://images.example/avatar.png",
  );
  // Barrier: a lazy image added on screen now is requested only after the
  // browser has evaluated lazy loading for the page, including the avatar.
  await page.evaluate(() => {
    const sentinel = document.createElement("img");
    sentinel.loading = "lazy";
    sentinel.alt = "";
    sentinel.src = "https://images.example/sentinel.png";
    document.body.prepend(sentinel);
  });
  await expect.poll(() => sentinelRequests).toBe(1);
  expect(requests).toHaveLength(0);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(region).toBeInViewport();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].referer).toBeUndefined();

  await expect
    .poll(() => image.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveCSS("opacity", "1");
  await expect(avatar).toHaveText("");
  // Compare page coordinates: the fallback initial changes the line's baseline,
  // and the page is scrolled to its end, so a viewport box would move whenever
  // the document's height changes beneath the avatar.
  const box = () =>
    avatar.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x: x + scrollX, y: y + scrollY, width, height };
    });
  const original = await box();

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let failureRequests = 0;
  await page.route("https://images.example/failure.png", async (route) => {
    // The first request fails transiently; the same URL then succeeds.
    if (++failureRequests > 1)
      return route.fulfill({ path: artworkPath, contentType: "image/png" });
    await held;
    await route.abort();
  });
  await page.evaluate(() =>
    window.avatarFixture.setArtwork("https://images.example/failure.png"),
  );
  await expect(avatar).toContainText("A");
  await expect(image).toHaveCSS("opacity", "0");
  expect(await box()).toEqual(original);
  await pauseClock(page, 1_000);
  release();
  await expect(avatar).toContainText("A");
  await expect(avatar.locator("img")).toHaveCount(0);
  expect(failureRequests).toBe(1);
  // A mounted avatar recovers without a new source or remount. The retry timer
  // is armed after the failed commit, so advance until it fires; the exact
  // schedule is covered by Avatar.lifecycle.test.tsx.
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return failureRequests;
    })
    .toBe(2);
  await expect
    .poll(() => image.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveCSS("opacity", "1");
  await expect(avatar).toHaveText("");
});
