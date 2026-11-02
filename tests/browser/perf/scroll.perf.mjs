import { test, expect, repeats, timeline } from "./runner.mjs";
import { scrollCadence } from "./cadence.mjs";

// Short reading gesture within the loaded head; long gesture across preloaded
// history whose older rows have not yet been mounted/measured by the virtualizer.
for (const [name, distance, speed, count] of [
  ["scroll-short", 800, 1600, 120],
  ["scroll-long", 12000, 4000, 360],
]) {
  test.describe(name, () => {
    test.use({ historyCounts: { alpha: count, beta: 1 }, tallMessages: true });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        await perf.setup("alpha");
        const scroller = page.locator(timeline("alpha"));
        let released = 0;
        if (name === "scroll-long") {
          const older = scroller.locator(":scope > div:first-child button");
          for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
            while (released < app.pending.length)
              app.pending[released++].release();
            // Response delivery is not completion: verification yields between
            // batches. On the final page the loading control disappears instead
            // of returning to its ready label.
            await expect
              .poll(
                () =>
                  scroller.evaluate((element) => {
                    const edge = element.querySelector(
                      ":scope > div:first-child",
                    );
                    const button = edge.querySelector("button");
                    return button
                      ? !button.disabled &&
                          button.textContent === "Load older messages"
                      : !edge.querySelector('[role="status"]');
                  }),
                { message: "older page completes or exhausts history" },
              )
              .toBe(true);
            await perf.settle("alpha");
            if (!(await older.count())) break;
            await expect(older).toHaveText("Load older messages");
            await older.evaluate((button) => button.click());
            await expect
              .poll(() => app.pending.length)
              .toBeGreaterThan(released);
          }
          await expect(older).toHaveCount(0);
          await expect(
            scroller.getByText("History window limit reached", { exact: true }),
          ).toHaveCount(0);
        }
        await perf.settle("alpha");
        const before = await scroller.evaluate((element) => ({
          top: element.scrollTop,
          height: element.scrollHeight,
          viewport: element.clientHeight,
        }));
        expect(before.top, "room for the complete gesture").toBeGreaterThan(
          distance,
        );
        const point = await perf.gutter("alpha", "pointer");
        await perf.settle("alpha");
        const requestsBefore = app.pending.length;
        const sample = await perf.measure("alpha", {
          act: () =>
            perf.cdp.send("Input.synthesizeScrollGesture", {
              ...point,
              xDistance: 0,
              yDistance: distance,
              speed,
              gestureSourceType: "mouse",
              preventFling: true,
            }),
          work: {
            modality: "pointer",
            requestedPx: distance,
            speedPxPerSecond: speed,
            historyCount: count,
            olderPagesReleased: released,
            scrollTopBefore: before.top,
          },
        });
        const { frames, wheels } = sample.recording;
        const tops = frames
          .map((frame) => frame.top)
          .filter((top) => top !== null);
        const seen = new Set(
          frames.flatMap((frame) => frame.rows.map(([id]) => id)),
        );
        sample.metrics.scrollTopRangePx =
          Math.max(before.top, ...tops) - Math.min(before.top, ...tops);
        Object.assign(sample.metrics, scrollCadence(sample.recording));
        Object.assign(sample.work, {
          wheels,
          distinctVisibleRows: seen.size,
          olderReadsDuring: app.pending.length - requestsBefore,
          scrollTopAfter: tops.at(-1),
        });
        await perf.save(sample);
        expect(wheels, "real wheel input").toBeGreaterThan(0);
        expect(
          sample.work.olderReadsDuring,
          "no pagination in a rendering-only window",
        ).toBe(0);
        expect(
          sample.metrics.scrollTopRangePx,
          "gesture actually traverses history",
        ).toBeGreaterThan(distance * 0.8);
        expect(seen.size, "gesture exposes multiple messages").toBeGreaterThan(
          name === "scroll-short" ? 2 : 10,
        );
        // measure() rejects blank endings: empty frames reset its quiet barrier.
        expect(
          frames.at(-1).rows.map(([id]) => id),
          "visible messages change",
        ).not.toEqual(
          frames.find((frame) => frame.rows.length)?.rows.map(([id]) => id),
        );
      });
  });
}
