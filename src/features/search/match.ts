const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{N}]/u.test(char ?? "");

/** How well a label matches typed text, best first. Ranks are whole numbers,
 * so callers can order them and add fractional tie-breaks. */
export const MatchRank = {
  exact: 0,
  prefix: 1,
  /** The text starts a later word. */
  wordStart: 2,
  substring: 3,
  /** Each letter continues a run that began at a word start ("tlp" in
   * "team-launch-planning"). */
  wordRuns: 4,
  /** The letters appear in order. */
  inOrder: 5,
} as const;
export type MatchRank = (typeof MatchRank)[keyof typeof MatchRank];

/** How well a label matches typed text (`MatchRank`), or undefined for no
 * match. `positions` are the matched code points of the label, for
 * underlining. */
export function matchName(
  label: string,
  needle: string,
): { rank: MatchRank; positions: number[] } | undefined {
  const text = label.toLowerCase();
  const chars = [...text];
  // Lowercasing can change a label's length (İ → i̇). Rank it, but do not
  // underline positions that would land on the wrong letters.
  const aligned = chars.length === [...label].length;
  const found = (rank: MatchRank, positions: number[]) => ({
    rank,
    positions: aligned ? positions : [],
  });
  const run = (at: number) => {
    const from = [...text.slice(0, at)].length;
    return Array.from({ length: [...needle].length }, (_, n) => from + n);
  };
  if (text === needle) return found(MatchRank.exact, run(0));
  let substring: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return found(MatchRank.prefix, run(0));
    if (!isWordChar(text[at - 1])) return found(MatchRank.wordStart, run(at));
    substring ??= at;
  }
  if (substring !== undefined)
    return found(MatchRank.substring, run(substring));
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  if (!letters.length) return undefined;
  // Letters in order, the loosest rank. Without them nothing below matches,
  // so a name that misses skips the word-run search.
  const inOrder: number[] = [];
  chars.forEach((char, j) => {
    if (char === letters[inOrder.length]) inOrder.push(j);
  });
  if (inOrder.length < letters.length) return undefined;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const takes = (i: number, j: number, inRun: boolean) =>
    chars[j] === letters[i] &&
    (inRun || !isWordChar(chars[j - 1])) &&
    wordRuns(i + 1, j + 1, true);
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = takes(i, j, inRun) || wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (wordRuns(0, 0, false)) {
    // Replay the same choices the search made: take a letter when it leads
    // to a full match, otherwise skip the character.
    const positions: number[] = [];
    for (let i = 0, j = 0, inRun = false; i < letters.length; j += 1) {
      inRun = takes(i, j, inRun);
      if (inRun) {
        positions.push(j);
        i += 1;
      }
    }
    return found(MatchRank.wordRuns, positions);
  }
  return found(MatchRank.inOrder, inOrder);
}

export const matchRank = (label: string, needle: string) =>
  matchName(label, needle)?.rank;
