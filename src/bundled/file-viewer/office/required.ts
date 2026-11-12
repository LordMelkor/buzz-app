/** Narrow a value after the caller's format, frame, or index admission. */
export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing Office value");
  return value;
}
