import { test, expect, heads, repeats, sidebar } from "./runner.mjs";

// Variants change one condition of channel-open-cold.
for (const [name, hoverMs, options] of [
  ["channel-open-cold", 0, {}],
  ["channel-open-hover", 150, {}],
  ["channel-open-cold-markdown", 0, { markdownMessages: true }],
])
  test.describe(name, () => {
    test.use({
      historyCounts: { alpha: 1, beta: 120 },
      tallMessages: true,
      ...options,
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ app, perf }) => {
        await perf.setup("alpha");
        expect(
          heads(app, "beta"),
          "target has never been opened or prepared",
        ).toBe(0);
        const mode = hoverMs ? "hover" : "cold";
        const sample = await perf.measure("beta", {
          click: sidebar("beta"),
          hoverMs,
          work: { mode, hoverMs },
        });
        await perf.save(sample);
        if (mode === "cold")
          expect(sample.work.headReadsDuring).toBeGreaterThan(0);
        else
          expect(sample.recording.hoverLeadMs).toBeGreaterThanOrEqual(hoverMs);
        expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
      });
  });
