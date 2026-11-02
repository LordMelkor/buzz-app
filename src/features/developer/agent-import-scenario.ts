// Development only: stands in for what Import finds, so each case of the
// Agents page's import flow can be tried without arranging real communities
// and old Buzz data. Developer settings chooses it; its pretend imports
// change nothing.
import type { Agent, Agents, FoundAgents } from "../agents/service";

export type ImportScenario = "off" | "none" | "both" | "communities" | "old";
export type ImportScenarioSettings = Readonly<{
  scenario: ImportScenario;
  /** Shows the selected community as having no agents or teams yet. */
  empty: boolean;
}>;

const key = "buzz-dev-agent-import-scenario.v1";
const changedEvent = "buzz-dev-agent-import-scenario-changed";
const SCENARIOS: readonly ImportScenario[] = [
  "off",
  "none",
  "both",
  "communities",
  "old",
];
const OFF: ImportScenarioSettings = { scenario: "off", empty: false };
let current: ImportScenarioSettings | undefined;

export function importScenario(): ImportScenarioSettings {
  if (current) return current;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    current = {
      scenario: SCENARIOS.includes(saved?.scenario) ? saved.scenario : "off",
      empty: saved?.empty === true,
    };
  } catch {
    current = OFF;
  }
  return current;
}
export function setImportScenario(change: Partial<ImportScenarioSettings>) {
  current = { ...importScenario(), ...change };
  try {
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    // Kept for this session.
  }
  window.dispatchEvent(new Event(changedEvent));
}
export function subscribeImportScenario(listener: () => void) {
  window.addEventListener(changedEvent, listener);
  return () => window.removeEventListener(changedEvent, listener);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 600));
const fakeKey = (n: number) => n.toString(16).padStart(64, "0");

const communities = (scenario: ImportScenario) =>
  scenario === "both" || scenario === "communities";

/** What Import finds in old Buzz in `scenario`. */
function found(scenario: ImportScenario): FoundAgents {
  const old = scenario === "both" || scenario === "old";
  const portable = (n: number, name: string) => ({
    source: "harness" as const,
    pubkey: fakeKey(n),
    name,
    relay: "wss://relay.example.com",
  });
  return {
    here: [],
    warnings: [],
    agents: old ? [portable(11, "Honeybee"), portable(12, "Drone")] : [],
    teams: old
      ? [
          {
            id: "dev-old-team",
            name: "Hive",
            instructions: "",
            members: [
              { pubkey: fakeKey(11), name: "Honeybee", source: "harness" },
              { pubkey: fakeKey(12), name: "Drone", source: "harness" },
            ],
          },
        ]
      : [],
  };
}

/** An agent of `type`, in `relay` unless it was just imported here. */
function made(pubkey: string, type: string, name = "", relay = ""): Agent {
  return {
    key: pubkey,
    pubkey,
    name,
    type,
    owner: "",
    relay,
    place: "here",
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: false,
    config: undefined,
  };
}

/** The agents in the owner's other communities in `scenario`. */
function elsewhere(scenario: ImportScenario, type: string): readonly Agent[] {
  if (!communities(scenario)) return [];
  return [
    made(fakeKey(1), type, "Scout", "wss://design.example.com"),
    made(fakeKey(2), type, "Ledger", "wss://design.example.com"),
    made(fakeKey(3), type, "Atlas", "wss://research.example.com"),
  ];
}

/** `agents`, with Import's findings and actions, and optionally an empty
 * community, as the chosen scenario has them. Off leaves it as it is. */
export function withImportScenario(agents: Agents): Agents {
  const type = () => agents.types().find((entry) => !entry.remote)?.key ?? "";
  const active = () => importScenario().scenario !== "off";
  let real: ReturnType<Agents["snapshot"]> | undefined;
  let shown: ReturnType<Agents["snapshot"]> | undefined;
  let seen: ImportScenarioSettings | undefined;
  // Pretend joins, so an added agent leaves the list as a real one would.
  const joined = new Set<string>();
  const overrides: Partial<Agents> = {
    snapshot: () => {
      const next = agents.snapshot();
      const settings = importScenario();
      if (!active() && !settings.empty) return next;
      // A new snapshot for each scenario, so a page already open reads again.
      if (next !== real || settings !== seen) {
        real = next;
        seen = settings;
        shown = settings.empty
          ? { ...next, agents: [], running: [], teams: [] }
          : { ...next };
      }
      return shown ?? next;
    },
    subscribe: (listener) => {
      const stop = agents.subscribe(listener);
      const stopScenario = subscribeImportScenario(listener);
      return () => {
        stop();
        stopScenario();
      };
    },
    portable: async () =>
      active() ? found(importScenario().scenario) : agents.portable(),
    joinable: () =>
      active()
        ? elsewhere(importScenario().scenario, type()).filter(
            (agent) => !joined.has(agent.pubkey),
          )
        : agents.joinable(),
    join: async (key) => {
      if (!active()) return agents.join(key);
      await pause();
      joined.add(key);
      // One join shows how a note about what did not come over reads.
      const notes =
        key === fakeKey(2)
          ? ["Ledger's picture didn't come over. Choose one in its settings."]
          : [];
      return { agent: made(key, type()), notes };
    },
    port: async (input) => {
      if (!active()) return agents.port(input);
      await pause();
      const pubkey = "pubkey" in input ? input.pubkey : "";
      return { agent: made(pubkey, type()), notes: [] };
    },
    portTeam: async (input) => {
      if (!active()) return agents.portTeam(input);
      await pause();
      return { imported: [], failed: [], elsewhere: [], foreign: [] };
    },
  };
  return new Proxy(agents, {
    get: (target, name, receiver) =>
      Object.hasOwn(overrides, name)
        ? overrides[name as keyof Agents]
        : Reflect.get(target, name, receiver),
  });
}
