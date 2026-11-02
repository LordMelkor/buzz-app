import { expect, it } from "vitest";
import { emojiQuery } from "./emoji-query";
it("opens after two shortcode characters, at the real caret and word boundaries", () => {
  expect(emojiQuery("(:sm tail", 4)).toEqual({ start: 1, end: 4, query: "sm" });
  expect(emojiQuery(":+1", 3)?.query).toBe("+1");
  expect(emojiQuery("🧠 :party-parrot", 16)?.query).toBe("party-parrot");
  for (const text of [
    ":",
    ":s",
    ":smile:",
    "12:30",
    "https://site",
    "word:sm",
    ":sm ile",
    `:${"a".repeat(65)}`,
  ]) {
    expect(emojiQuery(text, text.length)).toBeNull();
  }
});

it("opens right after a converted emoji or a completed shortcode, without a space", () => {
  // `:smile:` converts to its glyph on the closing colon; the next shortcode starts at once.
  expect(emojiQuery("😄:wa", 5)).toEqual({ start: 2, end: 5, query: "wa" });
  expect(emojiQuery("👍🏽:wa", 7)?.query).toBe("wa");
  expect(emojiQuery("hi 😄:wave", 10)?.query).toBe("wave");
  // Subdivision flags are tag sequences that end in U+E007F, not a pictograph.
  const england =
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  expect(emojiQuery(`${england}:wa`, england.length + 3)?.query).toBe("wa");
  // Regional-indicator flags, keycaps and variation-selector endings are the other alternatives.
  for (const glyph of ["🇺🇸", "1️⃣", "❤️"]) {
    expect(emojiQuery(`${glyph}:wa`, glyph.length + 3)?.query).toBe("wa");
  }
  // Custom emoji stay as text, so the second shortcode follows the closing colon.
  expect(emojiQuery(":bufo::wa", 9)).toEqual({ start: 6, end: 9, query: "wa" });
  expect(emojiQuery(":bufo::party::wa", 16)?.query).toBe("wa");
  // Only a shortcode at its own boundary counts: `word:sm:` is not one.
  for (const text of ["std::vector", "foo:bar::baz", "12:30::45"]) {
    expect(emojiQuery(text, text.length)).toBeNull();
  }
});
