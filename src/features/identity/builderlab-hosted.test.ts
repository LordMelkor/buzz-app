import { expect, it } from "vitest";
import { relayOrigin } from "../communities/destination";
import type { FoundCommunity } from "../communities/find-community";
import { hostedByThisBuilderlab } from "./builderlab-hosted";

const PUBLIC = "https://app.builderlab.xyz";
const PUBLIC_SELF =
  "12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3";
/** As `findCommunity` reports it: the canonical origin, plus `self` when given. */
const found = (input: string, self?: string): FoundCommunity => ({
  url: relayOrigin(input),
  host: new URL(relayOrigin(input)).host,
  self,
  policy: null,
});
/** Whether a public build signs in for `input` at once. */
const hosted = (input: string, self?: string) =>
  hostedByThisBuilderlab(found(input, self), PUBLIC);

it.each([
  "wss://communities.buzz.xyz",
  "https://design.communities.buzz.xyz",
  "WSS://Design.Communities.BUZZ.xyz.",
  "https://communities.buzz.xyz:443",
])("%s is hosted by a public build's Builderlab", (input) => {
  expect(hosted(input)).toBe(true);
});

it.each([
  "wss://communities.buzz.xyz.evil.com",
  "wss://notcommunities.buzz.xyz",
  "wss://xcommunities.buzz.xyz",
  "wss://buzz.xyz",
  "wss://buzz.block.builderlab.xyz",
  "wss://buzz.acme.builderlab.xyz",
  "wss://relay.example.com",
  "https://communities.buzz.xyz:8443",
])("%s is not hosted by a public build's Builderlab", (input) => {
  expect(hosted(input)).toBe(false);
});

it.each([
  ["", false],
  ["not a url", false],
  // Only the origin counts: the build URL carries the API's base path.
  ["https://app.builderlab.xyz/api/goose/", true],
  // Another deployment's portal, as a federated-identity build derives it.
  ["https://block.builderlab.xyz", false],
])("a build URL of %j hosts communities.buzz.xyz: %s", (build, expected) => {
  expect(
    hostedByThisBuilderlab(found("wss://design.communities.buzz.xyz"), build),
  ).toBe(expected);
});

it("falls back to the relay key when the hostname is unknown, on the default port only", () => {
  // A deployment moved to a new domain keeps its relay key.
  expect(hosted("wss://buzz.example", PUBLIC_SELF)).toBe(true);
  expect(hosted("https://buzz.example:8443", PUBLIC_SELF)).toBe(false);
  expect(hosted("wss://buzz.example", "ab".repeat(32))).toBe(false);
  // An unknown relay with no `self` never matches, even with no build URL.
  expect(hostedByThisBuilderlab(found("wss://buzz.example"), "")).toBe(false);
});
