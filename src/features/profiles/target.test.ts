import { expect, it } from "vitest";
import {
  claimProfileTranscript,
  openProfileTranscript,
  profileTranscriptRequest,
  profileAgentHint,
  profileActivityTranscript,
  profileActivityViewTarget,
  profileActivityViewKey,
  profileKey,
  profilePanelKey,
  profileTarget,
} from "./target";
it("round-trips only exact public identity locators", () => {
  const key = "ab".repeat(32);
  const target = profileTarget(key);
  expect(target).toMatch(/^nostr:npub1/);
  expect(profileKey(target ?? "")).toBe(key);
  expect(profilePanelKey(target ?? "")).toBe(key);
  expect(profileTarget(key.toUpperCase())).toBe(target);
  for (const invalid of ["", "author", "a".repeat(63), "g".repeat(64)])
    expect(profileTarget(invalid)).toBeUndefined();
  for (const invalid of [
    "nostr:nsec1abc",
    `${target}?relay=wss://evil.test`,
    `${target}/`,
    `${target}x`,
    key,
    "nostr:npub1abc",
  ])
    expect(profileKey(invalid)).toBeUndefined();
});

it("keeps agent appearance in an exact app-local target without changing public links", () => {
  const key = "ab".repeat(32);
  const target = profileTarget(key.toUpperCase(), { agent: true });
  expect(target).toBe(`buzz:agent-profile:${key}`);
  expect(profilePanelKey(target ?? "")).toBe(key);
  expect(profileKey(target ?? "")).toBeUndefined();
  expect(profileAgentHint(target ?? "")).toBe(true);
  expect(profileAgentHint(profileTarget(key) ?? "")).toBe(false);
  expect(profileTarget(key, { agent: false })).toBe(profileTarget(key));
  for (const invalid of [
    "buzz:agent-profile:",
    `${target}?owner=true`,
    `${target}/`,
    `${target}x`,
    `buzz:agent-profile:${"g".repeat(64)}`,
  ]) {
    expect(profileKey(invalid)).toBeUndefined();
    expect(profilePanelKey(invalid)).toBeUndefined();
    expect(profileAgentHint(invalid)).toBe(false);
  }
});

it("recognizes only the exact local profile Activity destination", () => {
  const key = "ab".repeat(32);
  const target = profileActivityViewTarget(key);
  expect(profileActivityViewTarget(key.toUpperCase())).toBe(target);
  expect(profileActivityViewKey(target ?? "")).toBe(key);
  expect(profileKey(target ?? "")).toBeUndefined();
  for (const invalid of ["", "not-a-key", "g".repeat(64)])
    expect(profileActivityViewTarget(invalid)).toBeUndefined();
  for (const invalid of [
    `${target}&owner=true`,
    `${target}#activity`,
    `${target}&agent=${key}`,
    `https://example.com?agent=${key}&tab=activity`,
    `buzz:profile?agent=${key}&tab=info`,
  ])
    expect(profileActivityViewKey(invalid)).toBeUndefined();
});

it("marks only the transcript Activity destination as asking for it", () => {
  const key = "ab".repeat(32);
  const plain = profileActivityViewTarget(key) ?? "";
  const transcript = profileActivityViewTarget(key, { transcript: true }) ?? "";
  expect(transcript).not.toBe(plain);
  expect(profileActivityViewKey(transcript)).toBe(key);
  expect(profileActivityTranscript(transcript)).toBe(true);
  expect(profileActivityTranscript(plain)).toBe(false);
  expect(profileActivityTranscript(`${transcript}&owner=true`)).toBe(false);
});

it("asks for a transcript once per opening until its profile claims it", () => {
  const key = "cd".repeat(32);
  const plain = profileActivityViewTarget(key) ?? "";
  const transcript = profileActivityViewTarget(key, { transcript: true }) ?? "";
  expect(openProfileTranscript(plain, () => true)).toBe(true);
  expect(profileTranscriptRequest(plain)).toBeUndefined();
  // An opening that fails leaves nothing for a later remount to act on.
  expect(openProfileTranscript(transcript, () => false)).toBe(false);
  expect(profileTranscriptRequest(transcript)).toBeUndefined();
  expect(openProfileTranscript(transcript, () => true)).toBe(true);
  const first = profileTranscriptRequest(transcript);
  expect(first).toBeDefined();
  expect(claimProfileTranscript(transcript)).toBe(first);
  expect(profileTranscriptRequest(transcript)).toBeUndefined();
  expect(claimProfileTranscript(transcript)).toBeUndefined();
  // Opening the same target again is a new opening.
  openProfileTranscript(transcript, () => true);
  expect(claimProfileTranscript(transcript)).toBeGreaterThan(first ?? 0);
});
