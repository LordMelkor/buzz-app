import { expect, it } from "vitest";
import { communityGitRepository } from "./git";

// Same name boundaries as the native signer test and the relay: one optional `.git`
// is stripped before the 1–64 character name rule.
const base = `https://relay.test/git/${"a".repeat(64)}`;

it.each([
  "plugins",
  "plugins.git",
  "plugins.",
  "plugins..git",
  "n".repeat(64),
  `${"n".repeat(64)}.git`,
])("accepts repository name %s", (name) => {
  expect(communityGitRepository("https://relay.test", `${base}/${name}`)).toBe(
    `${base}/${name}`,
  );
});

it.each([
  ".hidden",
  "a..b",
  "a..b.git",
  ".git",
  "..git",
  "n".repeat(65),
  `${"n".repeat(65)}.git`,
])("rejects repository name %s", (name) => {
  expect(
    communityGitRepository("https://relay.test", `${base}/${name}`),
  ).toBeNull();
});
