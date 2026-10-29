import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster } from "./testing";

const viewer = keypair(),
  relay = keypair();
const open = (id: string) =>
  metadata(relay, id, id, 1_700_000_000, [["public"], ["t", "stream"]]);

it("evicts the least recently answered preview, never a channel discovery keeps", () => {
  const pinned = new Set(["held"]);
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey, 6, (id) =>
    pinned.has(id),
  );
  state.retain(new Set(), new Map());
  state.accept(roster(relay, "joined", [viewer.pubkey]));
  state.start({
    id: "solo",
    name: "Solo",
    channelType: "solo",
    members: [viewer.pubkey],
  });
  for (const id of ["joined", "solo", "held", "a", "b", "denied"])
    state.accept(open(id));
  state.deny("denied");
  expect(state.headroom()).toBe(2);

  // Answering "a" again is use: "b" is now the least recently answered.
  state.accept(open("a"));
  expect(state.accept(open("c"))).toBe(true);
  expect(state.get("b")).toBeUndefined();
  expect(state.get("a")).toMatchObject({ readOnly: true });
  expect(state.accept(open("d"))).toBe(true);
  expect(state.get("a")).toBeUndefined();
  for (const id of ["joined", "solo", "held", "denied", "c", "d"])
    expect(state.named(id)).toBe(true);

  // Only kept channels left: a new name is dropped, not swapped in.
  pinned.add("c").add("d");
  expect(state.headroom()).toBe(0);
  const overflow = state.overflowRevision;
  expect(state.accept(open("e"))).toBe(false);
  expect(state.overflowRevision).toBe(overflow + 1);
  expect(state.named("e")).toBe(false);
});
