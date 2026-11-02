// Attribute whole browser-reported frames that overlap the operation, not delivery.
// blockingDuration is a frame aggregate: clipping it proportionally is incorrect.
export function loafBlocking({ longAnimationFrames, durationMs }) {
  return longAnimationFrames
    .filter(
      ({ startMs, durationMs: frameDurationMs }) =>
        startMs < durationMs && startMs + frameDurationMs > 0,
    )
    .reduce((total, { blockingDurationMs }) => total + blockingDurationMs, 0);
}
