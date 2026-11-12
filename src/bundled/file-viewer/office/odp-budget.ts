// ODP geometry admission is independent of the document's text quota.
// Work includes source scans, equation operations, path rewrites and model creation.
// Calibration: 100k rectangles, 5 runs, WebKit 26.6 / M1 Max / macOS 27.2:
// worst admitted event-loop gap 353 ms; this is scoped evidence, not a time bound.
export const MAX_ODP_GEOMETRY_WORK = 4_000_000;
export const MAX_ODP_GEOMETRY_RETAINED = 4_000_000;
export const ODP_GEOMETRY_MODEL_WORK = 40;
