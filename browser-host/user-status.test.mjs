import { expect, it } from "vitest";
import { validStatusTemplate } from "./user-status.mjs";

const template = {
  kind: 30315,
  content: "",
  created_at: 1700000000,
  tags: [["d", "general"]],
};
it("admits clears, text-only, emoji-only, custom emoji and expiration", () => {
  for (const event of [
    template,
    { ...template, content: "Working remotely" },
    { ...template, tags: [...template.tags, ["emoji", "🏠"]] },
    {
      ...template,
      tags: [
        ...template.tags,
        ["emoji", ":party:"],
        ["expiration", "1700086400"],
      ],
    },
    {
      ...template,
      tags: [...template.tags, ["emoji", ":party:", "https://emoji.test/p"]],
    },
  ])
    expect(validStatusTemplate(event)).toBe(true);
});
it("rejects unrelated coordinates, duplicate tags, invalid times, channels and oversized values", () => {
  for (const patch of [
    { kind: 0 },
    { created_at: -1 },
    { created_at: 1.1 },
    { content: "x".repeat(101) },
    { tags: [] },
    { tags: [["d", "music"]] },
    { tags: [...template.tags, ["d", "general"]] },
    { tags: [...template.tags, ["h", "channel"]] },
    { tags: [...template.tags, ["emoji", "party", "https://wrong.test"]] },
    { tags: [...template.tags, ["emoji", "🎉", "https://emoji.test/p"]] },
    { tags: [...template.tags, ["emoji", ":party:", "data:image/png,x"]] },
    { tags: [...template.tags, ["emoji", ":party:", " https://emoji.test/p"]] },
    {
      tags: [
        ...template.tags,
        ["emoji", ":party:", `https://emoji.test/${"x".repeat(2030)}`],
      ],
    },
    {
      tags: [
        ...template.tags,
        ["emoji", ":party:", "https://emoji.test/p", "extra"],
      ],
    },
    { tags: [["d", "general", "https://wrong.test"]] },
    { tags: [...template.tags, ["expiration", "NaN"]] },
    { tags: [...template.tags, ["expiration", "1700086400"]] },
    { tags: [...template.tags, ["emoji", "x".repeat(101)]] },
  ])
    expect(validStatusTemplate({ ...template, ...patch })).toBe(false);
});

it("bounds future signing timestamps while allowing same-second replacements", () => {
  const now = 1700000000;
  expect(validStatusTemplate({ ...template, created_at: now + 300 }, now)).toBe(
    true,
  );
  expect(validStatusTemplate({ ...template, created_at: now + 301 }, now)).toBe(
    false,
  );
});

it.each([
  ["text at limit", { content: "x".repeat(100) }, true],
  ["UTF-16 emoji at limit", { content: "😀".repeat(50) }, true],
  ["UTF-16 emoji over limit", { content: "😀".repeat(51) }, false],
  ["untrimmed wire limit", { content: ` ${"x".repeat(100)} ` }, false],
  ["line feed", { content: "one\ntwo" }, false],
  ["non-string content", { content: null }, false],
  ["blank emoji tag", { tags: [...template.tags, ["emoji", " "]] }, false],
  ["multiline emoji", { tags: [...template.tags, ["emoji", "x\ny"]] }, false],
  [
    "emoji at limit",
    { tags: [...template.tags, ["emoji", "😀".repeat(50)]] },
    true,
  ],
  ["non-string emoji", { tags: [...template.tags, ["emoji", 1]] }, false],
])("preserves status wire policy: %s", (_name, patch, accepted) => {
  expect(validStatusTemplate({ ...template, ...patch })).toBe(accepted);
});
