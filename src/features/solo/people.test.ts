import { expect, it } from "vitest";
import { soloHasPeople, soloRoster } from "./people";

const viewer = "a".repeat(64);
const person = "b".repeat(64);
const owned = "c".repeat(64);
const outside = "d".repeat(64);
const loading = "e".repeat(64);
const profiles = new Map([
  [person, { name: "Teammate" }],
  [owned, { name: "Honey", isAgent: true as const }],
  [outside, { name: "Outside", isAgent: true as const }],
]);
const agents = new Set([owned, outside]);

it("offers the chat's people and the viewer's agents, never the viewer", () => {
  expect(
    soloRoster([viewer, person, owned, outside], viewer, profiles, agents, [
      { pubkey: owned, name: "Honey" },
    ]),
  ).toEqual([
    { pubkey: person, name: "Teammate" },
    { pubkey: owned, name: "Honey" },
  ]);
});

it("counts only a loaded, non-agent profile as another person", () => {
  expect(soloHasPeople([viewer, owned], viewer, profiles, agents)).toBe(false);
  expect(soloHasPeople([viewer, loading], viewer, profiles, agents)).toBe(
    false,
  );
  expect(soloHasPeople([viewer, person], viewer, profiles, agents)).toBe(true);
});
