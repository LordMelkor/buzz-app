import { test, expect } from "./playwright-test.mjs";
import { pauseClock } from "./clock.mjs";

// Exercise real browser clock/protocol behavior, not a mocked timer lifecycle.
test("a delayed pause sample preserves pending timers and Date advancement", async ({
  page,
}) => {
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  await page.evaluate(() => {
    window.clockFired = false;
    setTimeout(() => {
      window.clockFired = true;
    }, 1_000);
  });
  await pauseClock(
    {
      clock: page.clock,
      async evaluate(callback) {
        const sample = await page.evaluate(callback);
        // Model a delayed protocol response without a real wait or retry.
        await page.clock.runFor(500);
        return sample;
      },
    },
    100,
  );
  const paused = await page.evaluate(() => Date.now());
  await page.clock.runFor(399);
  expect(await page.evaluate(() => window.clockFired)).toBe(false);
  expect(await page.evaluate(() => Date.now())).toBe(paused + 399);
  await page.clock.runFor(1);
  expect(await page.evaluate(() => window.clockFired)).toBe(true);
  expect(await page.evaluate(() => Date.now())).toBe(paused + 400);
});
