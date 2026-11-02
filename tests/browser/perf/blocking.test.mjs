import { expect, test } from "vitest";
import { loafBlocking } from "./blocking.mjs";

test("sums native blocking of overlapping frames, including both boundaries and settling", () => {
  expect(
    loafBlocking({
      durationMs: 500,
      gestureEndMs: 200,
      longAnimationFrames: [
        // Whole boundary frames count; an earlier completed setup frame does not.
        { startMs: -100, durationMs: 100, blockingDurationMs: 50 },
        { startMs: -100, durationMs: 180, blockingDurationMs: 100 },
        { startMs: 0, durationMs: 110, blockingDurationMs: 30 },
        { startMs: 220, durationMs: 100, blockingDurationMs: 0 },
        { startMs: 400, durationMs: 120, blockingDurationMs: 40 },
        { startMs: 500, durationMs: 200, blockingDurationMs: 150 },
      ],
    }),
  ).toBe(170);
});

test("reports zero for a supported recording with no long frames", () => {
  expect(loafBlocking({ longAnimationFrames: [], durationMs: 500 })).toBe(0);
});
