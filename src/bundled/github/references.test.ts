import { expect, it } from "vitest";
import { parseGitHubReference } from "./references";

it("recognizes typed GitHub references while refusing lookalike hosts and invalid targets", () => {
  for (const [path, kind] of [
    ["block/buzz", "repository"],
    ["block/buzz/pull/23", "pull"],
    ["block/buzz/issues/12", "issue"],
    ["block/buzz/commit/abcdef1234", "commit"],
    ["block/buzz/pull/2147483647", "pull"],
  ]) {
    expect(parseGitHubReference(`https://github.com/${path}`)?.kind).toBe(kind);
  }
  for (const url of [
    "https://github.com.evil.test/block/buzz/pull/23",
    "https://someone@github.com/block/buzz",
    "http://github.com/block/buzz",
    "https://github.com/block/buzz/tree/main",
    "https://github.com/block/buzz/blob/main/README.md",
    "https://github.com/block/buzz/pull/0",
    "https://github.com/block/buzz/pull/2147483648",
    "https://github.com/block/buzz/issues/99999999999",
    "https://github.com/block/buzz/commit/nope",
  ])
    expect(parseGitHubReference(url)).toBeUndefined();
});

it("claims only PR and issue links whose target the pane can show", () => {
  const pull = "https://github.com/block/buzz-app/pull/838";
  expect(parseGitHubReference(`${pull}?view=all`)?.url).toBe(pull);
  expect(
    parseGitHubReference("https://github.com/block/buzz-app/issues/12"),
  ).toEqual({
    url: "https://github.com/block/buzz-app/issues/12",
    repository: "block/buzz-app",
    kind: "issue",
    label: "#12",
  });
  for (const url of [
    `${pull}#issuecomment-123`,
    `${pull}#pullrequestreview-456`,
    `${pull}#discussion_r4240253516`,
    `${pull}#event-987`,
    `${pull}#partial-timeline`,
    `${pull}#issuecomment-`,
    `${pull}#pullrequestreview-abc`,
    `${pull}/files`,
    `${pull}/files#diff-0123abcd`,
    `${pull}/files#r4240253516`,
    `${pull}/files/abcdef1..0123456`,
    `${pull}/commits`,
    `${pull}/commits/abcdef1`,
    `${pull}/commits/abcdef1#r4240253516`,
    `${pull}/checks`,
    `${pull}/checks?check_run_id=1`,
    `${pull}/conflicts`,
    `${pull}/changes`,
    `${pull}/activity`,
    "https://github.com/block/buzz-app/issues/12#issuecomment-123",
  ])
    expect(parseGitHubReference(url), url).toBeUndefined();
});

it("identifies the parent pull request for badges without claiming its navigation target", () => {
  const pull = "https://github.com/block/buzz-app/pull/2043";
  for (const suffix of [
    "#top",
    "#issuecomment-123",
    "?view=all#discussion_r456",
    "/commits",
    "/commits/abcdef1#r456",
    "/checks?check_run_id=1",
    "/changes",
    "/files#diff-0123abcd",
    "/files/abcdef1..0123456",
    "/activity/",
  ]) {
    expect(parseGitHubReference(`${pull}${suffix}`), suffix).toBeUndefined();
    expect(
      parseGitHubReference(`${pull}${suffix}`, { pullSubtargets: true }),
      suffix,
    ).toEqual(parseGitHubReference(pull));
  }
  for (const url of [
    "https://github.com.evil.test/block/buzz/pull/23/checks",
    "https://someone@github.com/block/buzz/pull/23#top",
    "https://github.com:123/block/buzz/pull/23/checks",
    "http://github.com/block/buzz/pull/23#top",
    "https://github.com/block/buzz/pull/0/checks",
    "https://github.com/block/buzz/pull/2147483648#top",
    "https://github.com/block/buzz/pull/23oops/checks",
    "https://github.com/block/buzz/issues/12#issuecomment-123",
    "https://github.com/block/buzz/issues/12/checks",
  ])
    expect(
      parseGitHubReference(url, { pullSubtargets: true }),
      url,
    ).toBeUndefined();
});
