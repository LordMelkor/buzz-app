/**
 * The one rule for matching a typed name to a person or agent name. Mentions,
 * New message recipients, the message search author picker and the
 * add-member search use it, so the same text finds the same people. The
 * normative statement and portable fixtures live in the mention rules
 * (src/bundled/mentions/README.md, section 3).
 */

// Accents that fold away: the Unicode "Combining Diacritical Marks" blocks.
// Other marks stay, because in many scripts (Devanagari vowel signs, Japanese
// dakuten) a mark makes a different letter, not an accented one.
const accent =
  /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/gu;

// Fold one code point: no accents, lowercase, and σ for final ς. Folding each
// code point alone keeps a map from folded text back to the name for
// underlining, and gives the same result as folding the whole name.
const foldPoint = (char: string) =>
  char.normalize("NFKD").replace(accent, "").toLowerCase().replace(/ς/g, "σ");

/** A name or query without accents and case. Keeps spaces at the ends. */
export const foldName = (text: string) => [...text].map(foldPoint).join("");

/** The normalized form for comparing and ordering names. */
export const normalizeName = (text: string) => foldName(text).trim();

/** Words are runs of letters, marks and digits; anything else separates them. */
const wordChar = /[\p{L}\p{M}\p{N}]/u;
const isWord = (char: string | undefined) => !!char && wordChar.test(char);
// The same characters that ECMAScript `trim` removes.
const space = /\s/u;

/**
 * Whether `name` is longer than `query` and continues it with a new word, as
 * `Jose Luis` and `Jose-Luis` continue `jose` but `Josefa` does not. Such a
 * name keeps Space from selecting a shorter exact name.
 */
export function extendsName(name: string, query: string) {
  const whole = [...normalizeName(name)];
  const needle = [...normalizeName(query)];
  return (
    needle.length > 0 &&
    whole.length > needle.length &&
    needle.every((char, n) => whole[n] === char) &&
    !isWord(whole[needle.length])
  );
}

/**
 * The one item whose name is exactly `query`, for Space to complete. There is
 * none when two items have that name or any item has a longer name that
 * continues it (`Avery` waits while `Avery Chen` exists). Only items that
 * `canComplete` allows can be chosen, but every item's `longer` names (by
 * default its names) can block one.
 */
export function exactName<T>(
  items: readonly T[],
  names: (item: T) => readonly string[],
  query: string,
  canComplete: (item: T) => boolean = () => true,
  longer: (item: T) => readonly string[] = names,
): T | undefined {
  const needle = normalizeName(query);
  if (!needle) return undefined;
  if (
    items.some((item) => longer(item).some((name) => extendsName(name, needle)))
  )
    return undefined;
  const exact = items.filter(
    (item) =>
      canComplete(item) &&
      names(item).some((name) => normalizeName(name) === needle),
  );
  return exact.length === 1 ? exact[0] : undefined;
}

// Bounds on one name's index entries. Names come from member profiles, so a
// many-word name must not grow the index with the square of its length.
const startLimit = 16;
const startLength = 32;

/**
 * Where `matchPerson` can begin a match in `name`: the folded, trimmed name
 * itself and each later word start, each cut to its first 32 code points. A
 * query matches only where one of these starts with the query's first 32 code
 * points, so a sorted list of them finds matches by search. A name with more
 * than 16 starts is not `complete`: callers must match it directly.
 */
export function nameStarts(name: string) {
  const chars = [...name].flatMap((char) => [...foldPoint(char)]);
  let start = 0;
  let end = chars.length;
  while (start < end && space.test(chars[start] ?? "")) start += 1;
  while (end > start && space.test(chars[end - 1] ?? "")) end -= 1;
  const key = (from: number) =>
    chars.slice(from, Math.min(end, from + startLength)).join("");
  const starts = [key(start)];
  for (let from = start + 1; from < end; from += 1)
    if (isWord(chars[from]) && !isWord(chars[from - 1])) {
      if (starts.length === startLimit) return { starts, complete: false };
      starts.push(key(from));
    }
  return { starts, complete: true };
}

/** A query cut to the length of `nameStarts` entries. */
export const startKey = (needle: string) =>
  [...needle].slice(0, startLength).join("");

export type PersonMatch = {
  /** 0 equal, 1 name starts with the query, 2 a word equals it, 3 a word starts with it. */
  tier: 0 | 1 | 2 | 3;
  /** Code point indexes of `name` that matched, for underlining. */
  positions: number[];
};

/** How `name` matches `query`, or undefined. An empty query matches at tier 0. */
export function matchPerson(
  name: string,
  query: string,
): PersonMatch | undefined {
  const needle = [...normalizeName(query)];
  // Folded code points of the name, each with the name code points it came
  // from. A code point that folds away (a combining accent) joins the one
  // before it, so an underline never splits a letter from its accent.
  const chars: string[] = [];
  const origin: number[][] = [];
  [...name].forEach((char, index) => {
    const pieces = [...foldPoint(char)];
    if (!pieces.length) origin.at(-1)?.push(index);
    for (const piece of pieces) {
      chars.push(piece);
      origin.push([index]);
    }
  });
  let start = 0;
  let end = chars.length;
  while (start < end && space.test(chars[start] ?? "")) start += 1;
  while (end > start && space.test(chars[end - 1] ?? "")) end -= 1;
  if (!needle.length) return { tier: 0, positions: [] };
  const at = (from: number) =>
    from + needle.length <= end &&
    needle.every((char, n) => chars[from + n] === char);
  const found = (tier: PersonMatch["tier"], from: number) => ({
    tier,
    positions: [...new Set(origin.slice(from, from + needle.length).flat())],
  });
  if (end - start === needle.length && at(start)) return found(0, start);
  if (end - start > needle.length && at(start)) return found(1, start);
  // A later word: the match starts where a word starts. It is that whole
  // word (tier 2) when it also ends where a word ends. A query with a space
  // matches only from the start of the name.
  if (needle.some((char) => space.test(char))) return undefined;
  let prefix: number | undefined;
  for (let from = start + 1; from < end; from += 1) {
    if (!isWord(chars[from]) || isWord(chars[from - 1]) || !at(from)) continue;
    const stop = from + needle.length;
    if (!isWord(chars[stop])) return found(2, from);
    prefix ??= from;
  }
  return prefix === undefined ? undefined : found(3, prefix);
}
