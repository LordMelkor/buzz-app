// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Agent, Agents } from "./service";
import { agentSections } from "./tabs";

afterEach(cleanup);

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
    "interest/triage": {
      slug: "interest/triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Triage." },
    },
    "watch/asks": {
      slug: "watch/asks",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
        classifier: {
          questions: { asks: { question: "Is this a question?" } },
        },
      },
    },
  },
} as Agent;

it("leaves the device Attention switch out of Settings", () => {
  const agents = {
    save: async () => {},
    subscribe: () => () => {},
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const sections = agentSections({
    agents,
    agent,
    type: undefined,
    memories: undefined,
    settingsHost: { typeControl: () => <p>Provider</p> },
  });
  expect(sections.some((tab) => tab.value === "agent:attention")).toBe(false);
  const section = sections.find((tab) => tab.value === "agent:settings");
  render(<div>{section?.render()}</div>);
  expect(screen.getByText("Provider")).toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("adds no Settings tab when the host has nothing to set", () => {
  const sections = agentSections({
    agents: {
      save: async () => {},
      subscribe: () => () => {},
      memberships: () => [],
      configHistory: () => undefined,
      addedTabs: () => [],
      registerTab: () => {},
      controlAttention: () => {},
    } as unknown as Agents,
    agent,
    type: undefined,
    memories: undefined,
    settingsHost: {},
  });
  expect(sections.map((tab) => tab.value)).toEqual(["agent:memory"]);
});

it("shows each synced side's History as its own named section", () => {
  const side = (name: "settings" | "instructions") => ({
    side: name,
    expected: { channel: "c", d: name, type: `buzz.agent.${name}` },
    head: undefined,
    version: 0,
  });
  const snapshot = {};
  const history = {
    read: async () => [],
    sides: [side("settings"), side("instructions")],
    revise: async () => ({ ok: true }),
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    classifier: () => "available",
    save: async () => {},
    configHistory: () => history,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    memories: undefined,
  }).find((tab) => tab.value === "agent:history");
  render(<div>{section?.render()}</div>);
  expect(
    screen.getByRole("region", { name: "Settings history" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Instructions history" }),
  ).toBeInTheDocument();
});

it("adds plugin tabs to local agents only, before History", () => {
  const added = {
    id: "watching",
    key: "buzz.watching/watching",
    pluginId: "buzz.watching",
    revision: "1",
    title: "Watching",
    component: ({ agent }: { agent: Agent }) => <p>Watching {agent.name}</p>,
  };
  const agents = {
    save: async () => {},
    subscribe: () => () => {},
    memberships: () => [],
    configHistory: () => ({
      read: async () => [],
      sides: [],
      revise: async () => ({ ok: true }),
    }),
    addedTabs: () => [added],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const values = (place: Agent["place"]) =>
    agentSections({
      agents,
      agent: { ...agent, place } as Agent,
      type: undefined,
      memories: undefined,
    }).map((tab) => tab.value);
  expect(values("here")).toEqual([
    "agent:added:buzz.watching/watching",
    "agent:history",
    "agent:memory",
  ]);
  expect(values("hosted")).not.toContain("agent:added:buzz.watching/watching");
  expect(values("elsewhere")).toEqual([]);
  render(
    agentSections({ agents, agent, type: undefined, memories: undefined })
      .find((tab) => tab.value === "agent:added:buzz.watching/watching")
      ?.render(),
  );
  expect(screen.getByText("Watching Ada")).toBeInTheDocument();
});
