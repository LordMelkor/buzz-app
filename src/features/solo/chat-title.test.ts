import { expect, it } from "vitest";
import { startingChatTitle } from "./chat-title";

const link = `buzz://message?channel=design&id=${"c".repeat(64)}`;

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
