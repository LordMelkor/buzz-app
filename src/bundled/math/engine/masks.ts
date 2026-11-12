import { decodeString } from "micromark-util-decode-string";

/** One raw UTF-16 unit, invariant under reference-label folding and absent
 * from decoded/folded source. Keep punctuation/word flanking and raw offsets. */
export function maskCharacter(source: string, punctuation: boolean): string {
  const used = new Set(decodeString(source).toLowerCase().toUpperCase());
  const first = punctuation ? 0x2000 : 0xe000,
    last = punctuation ? 0x2bff : 0xf8ff;
  for (let code = first; code <= last; code++) {
    const char = String.fromCharCode(code);
    if (
      char === char.toLowerCase().toUpperCase() &&
      !used.has(char) &&
      (!punctuation || /[\p{P}\p{S}]/u.test(char))
    )
      return char;
  }
  // analyze() already fails closed to native text when preparation cannot map.
  throw Error("No collision-free Markdown mask");
}
