import { expect, it } from "vitest";
import { startingChatTitle } from "./chat-title";

const link = `buzz://message?channel=design&id=${"c".repeat(64)}`;

it("uses readable channel labels before truncating the title", () => {
  expect(
    startingChatTitle(
      "what is this about [\\#design-and-research-work](buzz://channel/b17e217e-1234-4567-8901-123456789abc)",
    ),
  ).toBe("what is this about #design-and-research-work");
  expect(
    startingChatTitle(
      `Read [guide](https://example.com/${"x".repeat(120)}) then discuss`,
    ),
  ).toBe("Read guide then discuss");
});

it("reads escaped and formatted labels across multiple links", () => {
  expect(
    startingChatTitle(
      "Compare [**A** \\[one\\]](https://example.com/a) with [`B` &amp; C](https://example.com/b)",
    ),
  ).toBe("Compare A [one] with B & C");
  expect(
    startingChatTitle("Read [the guide][ref]\n\n[ref]: https://example.com"),
  ).toBe("Read the guide [ref]: https://example.com");
});

it("preserves code, malformed links and unrelated Markdown source", () => {
  for (const text of [
    "Keep `[label](https://example.com)` literal",
    "Keep [label](unfinished",
    "Keep **bold** and literal \\# text",
  ])
    expect(startingChatTitle(text)).toBe(text);
});

it("truncates readable labels at 80 Unicode code points", () => {
  expect(startingChatTitle(`[${"🐝".repeat(81)}](https://example.com)`)).toBe(
    "🐝".repeat(80),
  );
});

it("titles a linked chat from the prompt after its leading source link", () => {
  expect(startingChatTitle(`${link} Investigate this failure`)).toBe(
    "Investigate this failure",
  );
  expect(startingChatTitle(`${link}\n${link} Compare both`)).toBe(
    "Compare both",
  );
});

it("never titles a link-only prompt with the link, but keeps later links", () => {
  expect(startingChatTitle("buzz://channel/design")).toBe("Chat");
  expect(
    startingChatTitle({
      text: `@Scout ${link}`,
      recipients: [{ pubkey: "a".repeat(64), name: "Scout", start: 0, end: 6 }],
    }),
  ).toBe("Chat");
  expect(startingChatTitle("Look at buzz://channel/design")).toBe(
    "Look at buzz://channel/design",
  );
});

it("strips a leading group chip, whose members share its span", () => {
  const member = (pubkey: string, name: string) => ({
    pubkey,
    name,
    label: "crew",
    start: 0,
    end: 5,
  });
  expect(
    startingChatTitle({
      text: "@crew @Ann plan the launch",
      recipients: [
        member("1".repeat(64), "Ann"),
        member("2".repeat(64), "Bo"),
        { pubkey: "1".repeat(64), name: "Ann", start: 6, end: 10 },
      ],
    }),
  ).toBe("plan the launch");
});
