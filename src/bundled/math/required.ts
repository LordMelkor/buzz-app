/** The value, or a thrown error: for test fixtures that must exist. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing value");
  return value;
}
