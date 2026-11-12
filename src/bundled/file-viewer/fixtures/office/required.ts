/** Fixture assumptions fail at their source instead of obscuring later assertions. */
export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing fixture value");
  return value;
}
