import { expect, it } from "vitest";
import { keypair, signed } from "../relay/testing";
import { recentHuddles } from "./discovery";

it("only the creator or relay can end a discovered huddle", () => {
  const creator = keypair(),
    relay = keypair(),
    stranger = keypair();
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  const payload = {
    content: JSON.stringify({ ephemeral_channel_id: room }),
    tags: [["h", parent]],
  };
  const start = signed(creator, { ...payload, kind: 48100, created_at: 10 });
  const fakeEnd = signed(stranger, { ...payload, kind: 48103, created_at: 11 });
  expect(
    recentHuddles([start, fakeEnd], parent, relay.pubkey, 20),
  ).toHaveLength(1);
  const realEnd = signed(relay, { ...payload, kind: 48103, created_at: 12 });
  expect(
    recentHuddles([start, fakeEnd, realEnd], parent, relay.pubkey, 20),
  ).toEqual([]);
  expect(recentHuddles([start], "other", relay.pubkey, 20)).toEqual([]);
});

it("ignores malformed content and a parent masquerading as its own huddle", () => {
  const creator = keypair();
  const parent = "00000000-0000-4000-8000-000000000001";
  for (const content of [
    "{",
    "null",
    JSON.stringify({ ephemeral_channel_id: parent }),
    JSON.stringify({ ephemeral_channel_id: "bad" }),
  ]) {
    expect(
      recentHuddles(
        [
          signed(creator, {
            content,
            tags: [["h", parent]],
            kind: 48100,
            created_at: 1,
          }),
        ],
        parent,
        undefined,
      ),
    ).toEqual([]);
  }
});

it("expires an unended candidate at the room TTL and ignores future starts", () => {
  const creator = keypair();
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  const start = signed(creator, {
    kind: 48100,
    created_at: 100,
    tags: [["h", parent]],
    content: JSON.stringify({ ephemeral_channel_id: room }),
  });
  expect(recentHuddles([start], parent, undefined, 99)).toEqual([]);
  expect(recentHuddles([start], parent, undefined, 3699)).toHaveLength(1);
  expect(recentHuddles([start], parent, undefined, 3700)).toEqual([]);
});
