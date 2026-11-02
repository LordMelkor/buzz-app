/** DM labels list people alphabetically, ignoring case, so one conversation
 * reads the same on every surface and is findable by any member's name. */
export function sortParticipantNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
