// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { expect, it } from "vitest";
import { describeWatch } from "./attention";
import type { Agent } from "./service";

const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/release-triage": {
      slug: "interest/release-triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Keep releases moving." },
    },
    "watch/questions": {
      slug: "watch/questions",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "release-triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
      },
    },
  },
};

it("names watches by what and where they wake", () => {
  const watch = agent.attention["watch/questions"]?.value;
  if (watch?.type !== "event") throw new Error("fixture");
  expect(describeWatch(watch, [{ id: "c1", name: "releases" }])).toBe(
    "Messages in #releases",
  );
  expect(describeWatch(watch)).toBe("Messages in 1 channel");
  expect(describeWatch({ ...watch, channels: "all", kinds: [] })).toBe(
    "Any event in any channel",
  );
});
