import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, roster } from "./testing";

const viewer = keypair(),
  relay = keypair(),
  agent = keypair();
const chat = "00000000-0000-4000-8000-0000000000aa";
function starting() {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.start({
    id: chat,
    name: "Start",
    channelType: "solo",
    members: [viewer.pubkey, agent.pubkey],
    creator: viewer.pubkey,
    createdAt: 1,
    updatedAt: 1,
  });
  return state;
}

it("a chat this device is starting stands in for access until a roster arrives", () => {
  const state = starting();
  expect(state.canAccess(chat)).toBe(true);
  expect(state.canParticipate(chat)).toBe(true);
  // A read racing the create is not a denial.
  state.deny(chat);
  expect(state.canAccess(chat)).toBe(true);
  expect(state.isPending(chat)).toBe(true);
});

it("a signed roster that removes the viewer ends a start whose metadata is still missing", () => {
  const state = starting();
  state.accept(roster(relay, chat, [viewer.pubkey, agent.pubkey], 10));
  expect(state.canAccess(chat)).toBe(true);
  const revision = state.accessRevision;
  state.accept(roster(relay, chat, [agent.pubkey], 20));
  expect(state.isPending(chat)).toBe(false);
  expect(state.canAccess(chat)).toBe(false);
  expect(state.canParticipate(chat)).toBe(false);
  expect(state.get(chat)).toBeUndefined();
  expect(state.accessRevision).toBeGreaterThan(revision);
});

it("a first signed roster without the viewer ends the start", () => {
  const state = starting();
  state.accept(roster(relay, chat, [agent.pubkey], 10));
  expect(state.isPending(chat)).toBe(false);
  expect(state.canAccess(chat)).toBe(false);
});
