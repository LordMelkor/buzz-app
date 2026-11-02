import { expect, it } from "vitest";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import { placeExactOpening } from "./exact-opening";

const root = "a".repeat(64);
const reply = "b".repeat(64);
const row = (fields: Partial<ChannelMessage>) =>
  ({ threadRootId: undefined, replyCount: 0, ...fields }) as ChannelMessage;
const window = (
  rows: readonly ChannelMessage[],
  fields: Partial<ChannelWindow> = {},
) =>
  ({
    channelId: "alpha",
    status: "ready",
    rows,
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    freshness: "verified",
    ...fields,
  }) as ChannelWindow;

it("opens a top-level message with replies in its own thread", () => {
  expect(
    placeExactOpening(window([row({ id: root, replyCount: 3 })]), root),
  ).toEqual({ inTimeline: false, rootId: root });
});

it("keeps a top-level message without replies in the timeline", () => {
  expect(placeExactOpening(window([row({ id: root })]), root)).toEqual({
    inTimeline: true,
    rootId: root,
  });
});

it("leaves replies, absent messages and unverified windows to the thread reader", () => {
  expect(
    placeExactOpening(window([row({ id: reply, threadRootId: root })]), reply),
  ).toEqual({ inTimeline: false });
  expect(placeExactOpening(window([]), root)).toEqual({ inTimeline: false });
  expect(
    placeExactOpening(
      window([row({ id: root })], { freshness: "cached" }),
      root,
    ),
  ).toEqual({ inTimeline: false });
  expect(
    placeExactOpening(window([row({ id: root })], { status: "error" }), root),
  ).toEqual({ inTimeline: false });
});
