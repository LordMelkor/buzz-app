import { expect, it } from "vitest";
import {
  ownSolo,
  SOLO_NAMED_LABEL,
  SOLO_LABEL,
  soloChatLinkName,
  soloLabels,
} from "./labels";

const id = "22222222-2222-4222-8222-222222222222";
const owner = "a".repeat(64);
const guest = "b".repeat(64);

it("names shared chats by their current name, falling back to the short ID", () => {
  expect(soloChatLinkName({ id, name: "Investigate the flaky test" })).toBe(
    "Investigate the flaky test",
  );
  expect(soloChatLinkName({ id, name: "PR 45 fixes" })).toBe("PR 45 fixes");
  expect(soloChatLinkName({ id, name: "  " })).toBe("22222222");
});

it("marks Solo only with its channel label", () => {
  expect(soloLabels([SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL, SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL])).toBe(false);
  expect(soloLabels([])).toBe(false);
  expect(soloLabels(undefined)).toBe(false);
});

it("files a Solo chat as the viewer's own only when they created it", () => {
  const solo = { channelType: "solo", creator: owner };
  expect(ownSolo(solo, owner)).toBe(true);
  expect(ownSolo(solo, guest)).toBe(false);
  expect(ownSolo(solo, undefined)).toBe(false);
  expect(ownSolo({ channelType: "solo" }, owner)).toBe(false);
  expect(ownSolo({ channelType: "stream", creator: owner }, owner)).toBe(false);
  expect(ownSolo(undefined, owner)).toBe(false);
});
