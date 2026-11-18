import { describe, expect, it } from "vitest";
import {
  noticeFilter,
  parseWindow,
  verifyChannelWindows,
  windowFilter,
} from "./window";
import { bounds, keypair, message } from "./testing";

const relay = keypair(),
  author = keypair(),
  impostor = keypair();
const channel = "chan-1";
const id = "a".repeat(64);

describe("channel window bounds", () => {
  it("requests top-level rows with aux and summaries, and only echoes a full composite cursor", () => {
    expect(windowFilter(channel, null)).toMatchObject({
      kinds: [9, 40002, 40008, 48100, 48103],
      "#h": [channel],
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    expect(windowFilter(channel, null)).not.toHaveProperty("until");
    expect(
      windowFilter(channel, { createdAt: 5, eventId: id }, 999),
    ).toMatchObject({ until: 5, before_id: id, limit: 200 });
  });
  it("leaves aux and summaries out of bare probe reads", () => {
    const bare = windowFilter(channel, null, 200, false);
    expect(bare).toMatchObject({ top_level: true, limit: 200 });
    expect(bare).not.toHaveProperty("include_aux");
    expect(bare).not.toHaveProperty("include_summaries");
  });
  it("reads the relay's membership notices apart, by the same composite cursor", () => {
    expect(noticeFilter(channel, relay.pubkey, null)).toEqual({
      kinds: [40099],
      "#h": [channel],
      authors: [relay.pubkey],
      limit: 500,
    });
    expect(
      noticeFilter(channel, relay.pubkey, { createdAt: 5, eventId: id }),
    ).toMatchObject({ until: 5, before_id: id });
  });
  it("accepts exactly one relay-signed bound for the requested cursor and strips overlays", () => {
    const row = message(author, channel, "hi", 10);
    const page = parseWindow(channel, null, relay.pubkey, [
      row,
      bounds(relay, channel, "head", {
        has_more: true,
        next_cursor: { created_at: 10, id },
      }),
    ]);
    expect(page.events).toEqual([row]);
    expect(page).toMatchObject({
      hasMore: true,
      cursor: { createdAt: 10, eventId: id },
    });
    const last = parseWindow(
      channel,
      { createdAt: 10, eventId: id },
      relay.pubkey,
      [
        bounds(relay, channel, `10:${id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ],
    );
    expect(last).toMatchObject({ hasMore: false, cursor: null, events: [] });
  });
  it("rejects missing, duplicated, foreign, mismatched or self-contradicting bounds", () => {
    const good = bounds(relay, channel, "head", {
      has_more: false,
      next_cursor: null,
    });
    expect(() => parseWindow(channel, null, relay.pubkey, [])).toThrow(
      /invalid window bounds/,
    );
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [good, good]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(impostor, channel, "head", {
          has_more: false,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, `10:${id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, "other", "head", { has_more: false, next_cursor: null }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", { has_more: true, next_cursor: null }),
      ]),
    ).toThrow(/contradict/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", {
          has_more: true,
          next_cursor: { created_at: 1, id: "nope" },
        }),
      ]),
    ).toThrow(/cursor is malformed/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", {
          has_more: "yes" as unknown as boolean,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/omit has_more/);
  });
});

it("advances valid equal-time composite history cursors deterministically", () => {
  const cursor = { createdAt: 10, eventId: "a".repeat(64) };
  const nextId = "b".repeat(64);
  const page = parseWindow(channel, cursor, relay.pubkey, [
    bounds(relay, channel, `10:${cursor.eventId}`, {
      has_more: true,
      next_cursor: { created_at: 10, id: nextId },
    }),
  ]);
  expect(page.cursor).toEqual({ createdAt: 10, eventId: nextId });
});

describe("forward window pages", () => {
  const at = { createdAt: 10, eventId: "b".repeat(64) };
  const done = { has_more: false, next_cursor: null };
  it("accept only the bound of their own lane and direction", () => {
    expect(
      parseWindow(
        channel,
        at,
        relay.pubkey,
        [
          bounds(relay, channel, `newer:10:${at.eventId}`, {
            ...done,
            direction: "newer",
          }),
        ],
        true,
      ),
    ).toMatchObject({ hasMore: false });
    expect(() =>
      parseWindow(
        channel,
        at,
        relay.pubkey,
        [bounds(relay, channel, `10:${at.eventId}`, done)],
        true,
      ),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(
        channel,
        at,
        relay.pubkey,
        [bounds(relay, channel, `newer:10:${at.eventId}`, done)],
        true,
      ),
    ).toThrow(/malformed/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "newer:head", { ...done, direction: "newer" }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", { ...done, direction: "newer" }),
      ]),
    ).toThrow(/malformed/);
  });
  it.each([
    { newer: false, next: { created_at: 9, id: at.eventId }, advances: true },
    {
      newer: false,
      next: { created_at: 10, id: "c".repeat(64) },
      advances: true,
    },
    {
      newer: false,
      next: { created_at: 10, id: "a".repeat(64) },
      advances: false,
    },
    { newer: false, next: { created_at: 10, id: at.eventId }, advances: false },
    { newer: false, next: { created_at: 11, id: at.eventId }, advances: false },
    { newer: true, next: { created_at: 11, id: at.eventId }, advances: true },
    {
      newer: true,
      next: { created_at: 10, id: "a".repeat(64) },
      advances: true,
    },
    {
      newer: true,
      next: { created_at: 10, id: "c".repeat(64) },
      advances: false,
    },
    { newer: true, next: { created_at: 9, id: at.eventId }, advances: false },
    { newer: true, next: { created_at: 10, id: at.eventId }, advances: false },
  ])(
    "a cursor must move on in relay order (newer $newer, next $next.created_at)",
    ({ newer, next, advances }) => {
      const parse = () =>
        parseWindow(
          channel,
          at,
          relay.pubkey,
          [
            bounds(relay, channel, `${newer ? "newer:" : ""}10:${at.eventId}`, {
              has_more: true,
              next_cursor: next,
              ...(newer ? { direction: "newer" } : {}),
            }),
          ],
          newer,
        );
      if (advances)
        expect(parse().cursor).toEqual({
          createdAt: next.created_at,
          eventId: next.id,
        });
      else expect(parse).toThrow(/does not advance/);
    },
  );
});

describe("reader verification of channel pages", () => {
  const at = { createdAt: 10, eventId: "b".repeat(64) };
  const done = { has_more: false, next_cursor: null };
  const older = windowFilter(channel, at);
  const forward = {
    ...windowFilter(channel, null),
    direction: "newer" as const,
    after: at.createdAt,
    after_id: at.eventId,
  };
  const olderBound = bounds(relay, channel, `10:${at.eventId}`, done);
  const forwardBound = bounds(relay, channel, `newer:10:${at.eventId}`, {
    ...done,
    direction: "newer",
  });
  const verify =
    (
      filters: Parameters<typeof verifyChannelWindows>[0],
      events: Parameters<typeof verifyChannelWindows>[1],
    ) =>
    () =>
      verifyChannelWindows(filters, events, relay.pubkey);
  it("passes valid pages of both lanes and ignores reads without top_level", () => {
    const row = message(author, channel, "hi", 10);
    expect(verify([older], [row, olderBound])).not.toThrow();
    expect(verify([forward], [row, forwardBound])).not.toThrow();
    expect(verify([older, forward], [olderBound, forwardBound])).not.toThrow();
    expect(
      verify([{ kinds: [9], "#h": [channel], limit: 5 }], [row]),
    ).not.toThrow();
  });
  it("rejects a missing, duplicated, foreign, wrong-lane or stray bound", () => {
    expect(verify([older], [])).toThrow(/invalid window bounds/);
    expect(verify([older], [olderBound, olderBound])).toThrow(
      /invalid window bounds/,
    );
    expect(
      verify([older], [bounds(impostor, channel, `10:${at.eventId}`, done)]),
    ).toThrow(/invalid window bounds/);
    expect(
      verify(
        [older],
        [olderBound, bounds(impostor, channel, `10:${at.eventId}`, done)],
      ),
    ).toThrow(/invalid window bounds/);
    expect(verify([forward], [olderBound])).toThrow(/invalid window bounds/);
    expect(verify([older], [forwardBound])).toThrow(/invalid window bounds/);
    expect(
      verify([older], [olderBound, bounds(relay, "other", "head", done)]),
    ).toThrow(/invalid window bounds/);
    expect(
      verify(
        [{ kinds: [9], "#h": [channel], limit: 5 }, older],
        [olderBound, forwardBound],
      ),
    ).toThrow(/invalid window bounds/);
  });
  it("rejects a page that does not advance and a filter without exactly one channel", () => {
    expect(
      verify(
        [forward],
        [
          bounds(relay, channel, `newer:10:${at.eventId}`, {
            has_more: true,
            next_cursor: { created_at: 9, id: at.eventId },
            direction: "newer",
          }),
        ],
      ),
    ).toThrow(/does not advance/);
    const { "#h": _h, ...unscoped } = older;
    expect(verify([unscoped], [olderBound])).toThrow(/invalid window bounds/);
    expect(
      verify([{ ...older, "#h": [channel, "other"] }], [olderBound]),
    ).toThrow(/invalid window bounds/);
  });
  it("rejects two windows a single bound cannot tell apart", () => {
    expect(
      verify([older, { ...older, limit: 5 }], [olderBound, olderBound]),
    ).toThrow(/invalid window bounds/);
  });
});
