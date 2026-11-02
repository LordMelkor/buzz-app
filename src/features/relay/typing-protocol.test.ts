import { expect, it } from "vitest";
import { validTypingTemplate } from "./typing-protocol";

const channel = ["h", "dm-private"];
const reply = ["e", "a".repeat(64), "", "reply"];
const root = ["e", "b".repeat(64), "", "root"];
const pulse = {
  kind: 20002,
  content: "",
  created_at: 1_800_000_000,
  tags: [channel],
};

it("admits only empty channel or canonical thread pulses", () => {
  for (const tags of [[channel], [channel, reply], [channel, root, reply]])
    expect(validTypingTemplate({ ...pulse, tags })).toBe(true);
  for (const value of [
    null,
    {},
    { ...pulse, content: "draft" },
    { ...pulse, kind: 9 },
    { ...pulse, created_at: NaN },
    { ...pulse, created_at: -1 },
    { ...pulse, tags: null },
    { ...pulse, tags: [null] },
    ...[
      [],
      [channel, channel],
      [["h", ""]],
      [["h", "dm", "extra"]],
      [channel, root],
      [channel, reply, root],
      [channel, reply, reply],
      [channel, ["p", "a".repeat(64)]],
      [channel, ["e", "bad", "", "reply"]],
      [channel, ["e", "a".repeat(64), "wss://other", "reply"]],
      [channel, ["e", "a".repeat(64), "", "reply", "extra"]],
    ].map((tags) => ({ ...pulse, tags })),
  ])
    expect(validTypingTemplate(value), JSON.stringify(value)).toBe(false);
});
