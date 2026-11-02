import { expect, it } from "vitest";
import { soloRecipients } from "./recipients";
import type { ChannelSummary, Profile } from "../relay/contracts";
const viewer = "a".repeat(64),
  agent = "b".repeat(64),
  other = "c".repeat(64);
const library = {
  status: "ready" as const,
  definitions: [],
  identities: [{ pubkey: agent, name: "Agent" }],
};
const channel: ChannelSummary = {
  id: "chat",
  name: "Work",
  channelType: "solo",
  members: [viewer, agent],
};
const profiles = new Map<string, Profile>();
it("uses only roster members and deduplicates a known sole agent", () => {
  expect(
    soloRecipients(
      { ...channel, members: [viewer, agent, agent] },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([agent]);
  expect(
    soloRecipients(
      { ...channel, members: [viewer] },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([]);
});
it("does not confuse a missing profile with a human or guess from display names", () => {
  const multiple = { ...channel, members: [viewer, agent, other] };
  expect(() => soloRecipients(multiple, profiles, library, viewer, [])).toThrow(
    /loading/,
  );
  expect(
    soloRecipients(
      multiple,
      new Map([[other, { name: "Agent" }]]),
      library,
      viewer,
      [],
    ),
  ).toEqual([agent]);
  expect(() =>
    soloRecipients(
      multiple,
      new Map([[other, { name: "Agent", isAgent: true }]]),
      library,
      viewer,
      [],
    ),
  ).toThrow(/multiple/);
});
it("preserves explicit recipients and leaves ordinary channels unchanged", () => {
  expect(soloRecipients(channel, profiles, library, viewer, [other])).toEqual([
    other,
  ]);
  expect(
    soloRecipients(
      { ...channel, channelType: "stream" },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([]);
});

it("does not mistake an agent-library refresh for evidence of a sole agent", () => {
  const multiple = { ...channel, members: [viewer, agent, other] };
  const knownProfiles = new Map<string, Profile>([
    [agent, { name: "Local agent" }],
    [other, { name: "Shared agent", isAgent: true }],
  ]);
  expect(() =>
    soloRecipients(
      multiple,
      knownProfiles,
      { ...library, status: "loading", identities: [] },
      viewer,
      [],
    ),
  ).toThrow(/loading/);
  expect(() =>
    soloRecipients(
      multiple,
      knownProfiles,
      { ...library, status: "loading" },
      viewer,
      [],
    ),
  ).toThrow(/multiple/);
});
