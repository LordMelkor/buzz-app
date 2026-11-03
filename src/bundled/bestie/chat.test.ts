import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { bestieChat } from "./chat";

const viewer = "a".repeat(64),
  bestie = "b".repeat(64),
  other = "c".repeat(64);
const chat = (
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id,
  name: id,
  channelType: "dm",
  creator: viewer,
  members: [viewer, bestie],
  lastActivityAt: 10,
  ...overrides,
});
/** Absent metadata, as the relay leaves it: not a field set to undefined. */
const without = (
  channel: ChannelSummary,
  key: keyof ChannelSummary,
): ChannelSummary => {
  const { [key]: _absent, ...rest } = channel;
  return rest as ChannelSummary;
};

it("finds no chat without a viewer, a Bestie, or a matching chat", () => {
  expect(bestieChat([chat("one")], undefined, bestie)).toBeUndefined();
  expect(bestieChat([chat("one")], viewer, undefined)).toBeUndefined();
  expect(bestieChat([], viewer, bestie)).toBeUndefined();
  expect(bestieChat([chat("one")], viewer, bestie)?.id).toBe("one");
});

it("takes the most recently active chat, and never reorders on a tie", () => {
  const channels = [
    chat("older", { lastActivityAt: 5 }),
    chat("newest", { lastActivityAt: 30 }),
    chat("recent", { lastActivityAt: 20 }),
  ];
  expect(bestieChat(channels, viewer, bestie)?.id).toBe("newest");
  const tied = [
    chat("second", { lastActivityAt: 7, createdAt: 1 }),
    chat("first", { lastActivityAt: 7, createdAt: 4 }),
  ];
  expect(bestieChat(tied, viewer, bestie)?.id).toBe("first");
  // Activity may be unknown; creation still orders those chats.
  const unknown = [
    without(chat("old", { createdAt: 2 }), "lastActivityAt"),
    without(chat("new", { createdAt: 9 }), "lastActivityAt"),
  ];
  expect(bestieChat(unknown, viewer, bestie)?.id).toBe("new");
});

it("only counts verified unarchived DMs the viewer belongs to", () => {
  const wrong: readonly ChannelSummary[] = [
    chat("archived", { archived: true }),
    chat("stream", { channelType: "stream" }),
    without(chat("unclassified"), "channelType"),
    chat("Solo history", { channelType: "solo" }),
    chat("cached", { cached: true }),
    chat("other people", { members: [bestie, other] }),
  ];
  for (const channel of wrong)
    expect(bestieChat([channel], viewer, bestie)).toBeUndefined();
  expect(
    bestieChat([...wrong, chat("mine", { creator: other })], viewer, bestie)
      ?.id,
  ).toBe("mine");
});

it("requires the Bestie to be the one other member", () => {
  const wrong: readonly ChannelSummary[] = [
    chat("with a person", { members: [viewer, bestie, other] }),
    chat("another agent", { members: [viewer, other] }),
    chat("alone", { members: [viewer] }),
    // An unknown roster is not evidence of a match.
    without(chat("unknown roster"), "members"),
  ];
  for (const channel of wrong)
    expect(bestieChat([channel], viewer, bestie)).toBeUndefined();
  // A roster that repeats a member still names one other member.
  expect(
    bestieChat(
      [chat("dup", { members: [viewer, bestie, bestie, viewer] })],
      viewer,
      bestie,
    )?.id,
  ).toBe("dup");
});
