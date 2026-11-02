import { test, expect } from "./fixture.mjs";
import { closeSettings, openSettings } from "./navigation.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });

// Navigation aborts the previous attempt inside the next opening's click
// dispatch. A reason-less abort() made Blink mint a DOMException per abort whose
// unformatted V8 stack retained that click's target, so every Settings → Back
// kept the unmounted Settings navigation alive (about 450 nodes a cycle). jsdom
// has neither Blink's retention nor a forced GC; only Chromium exposes both
// through CDP, so WebKit is skipped rather than reported as leak-free.
test("Settings → Close releases the unmounted Settings DOM", async ({
  page,
  app,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Post-GC DOM node counts need CDP, which only Chromium exposes.",
  );
  await page.goto(app.origin);
  await button(page, "Alpha").click();
  await expect(composer(page)).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    const nodes = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      return metrics.find((metric) => metric.name === "Nodes").value;
    };
    const cycle = async () => {
      await openSettings(page);
      await closeSettings(page);
      await expect(composer(page)).toBeVisible();
    };

    // The first visit warms caches that legitimately outlive it; steady state
    // starts at the second cycle. Each leaked cycle added ~450 nodes.
    await cycle();
    const warm = await nodes();
    for (let i = 0; i < 4; i++) await cycle();
    const retained = (await nodes()) - warm;
    expect(retained).toBeLessThan(100);
  } finally {
    await cdp.detach();
  }
});
