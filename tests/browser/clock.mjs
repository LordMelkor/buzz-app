export async function pauseClock(page, advanceBy = 0) {
  const anchor = await page.evaluate(() => Date.now());
  // Freeze Date before pausing so protocol latency cannot overtake the target.
  // Keep existing timer deadlines, then let Date advance with runFor again.
  await page.clock.setFixedTime(anchor);
  await page.clock.pauseAt(anchor);
  await page.clock.setSystemTime(anchor);
  await page.clock.fastForward(advanceBy);
}
