// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import { readView, writeView } from "../../shared/view-state";
import { bestieTab } from "./BestieTab";
import { memory, withFeature } from "./features";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const NO_CHANNELS = { channels: [] };
const member = (name: string, digit: string): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
  }) as Agent;
const ada = member("Ada", "a");
const bea = member("Bea", "b");

/** Agents that save as a synced editor would: the agent's next config. */
function host(types = ["test/echo"]) {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = {
    save,
    types: () => types.map((key) => ({ key, adopt: () => ({}) })),
  } as unknown as Pick<Agents, "save" | "types">;
  return { agents, save };
}

function community(saved: string | undefined, agents = [ada, bea]) {
  let record = saved;
  const choice = (agent: Agent) => ({
    pubkey: agent.pubkey,
    name: agent.name,
    managed: true,
  });
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: agents.map(choice),
    selectable: agents.map(choice),
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: vi.fn(async () => record),
    write: vi.fn(async (agent: string) => {
      record = agent;
    }),
  };
  const connection = {
    status: "ready",
    scope: SCOPE,
    session: {
      viewer: OWNER,
      channels: {
        list: () => NO_CHANNELS,
        subscribeList: () => () => {},
        ensureList: () => () => {},
      },
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  let current: unknown = connection;
  const relayListeners = new Set<() => void>();
  const relay = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => void relayListeners.delete(listener);
    },
  } as unknown as RelayData;
  /** Replaces the session, as a reconnection does. */
  const reconnect = (scope: string) => {
    current = {
      ...connection,
      scope,
      session: { ...connection.session, mainAgent: { ...mainAgent } },
    };
    for (const listener of relayListeners) listener();
  };
  return { relay, mainAgent, reconnect };
}

it("shows on the saved Bestie only, and moves when Change picks another", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  // Nothing shows before the account's choice is read.
  expect(tab.when?.(ada)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(tab.when?.(bea)).toBe(false);
  // The same agent in another community is not this one's Bestie.
  expect(tab.when?.({ ...ada, relay: "wss://other.example" })).toBe(false);

  const Tab = tab.component;
  render(<Tab agent={ada} />);
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  // A type without instructions has nothing to switch.
  expect(screen.getByText("Remembers you")).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  changed.mockClear();
  await user.click(screen.getByRole("button", { name: "Change" }));
  // Change offers every other agent you can make Bestie.
  expect(screen.queryByRole("menuitem", { name: "Ada" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(bea.pubkey);
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(true));
  expect(tab.when?.(ada)).toBe(false);
  // The host is told, so the tab moves without a reload.
  expect(changed).toHaveBeenCalled();
  stop?.();
});

const deviceChoice = () => readView(SCOPE, "solo:default-agent", null);

/** Opens Change and confirms Bea in place of Ada. */
async function switchToBea(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  return confirmation;
}

it("puts this device back on the account's Bestie when a failed Change is closed with the panel", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  const tab = bestieTab(relay, host([]).agents);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  const confirmation = await switchToBea(user);
  expect(await within(confirmation).findByRole("alert")).toBeVisible();
  expect(deviceChoice()).toBe(bea.pubkey);
  // Closing the side panel, not Keep.
  unmount();
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("puts this device back when a Change still saving fails after the panel closes", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  let fail = (_: Error) => {};
  mainAgent.write.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const tab = bestieTab(relay, host([]).agents);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  await switchToBea(user);
  expect(deviceChoice()).toBe(bea.pubkey);
  unmount();
  await act(async () => fail(new Error("offline")));
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("keeps Change unavailable while there is no other agent to choose", async () => {
  const { relay } = community(ada.pubkey, [ada]);
  const Tab = bestieTab(relay, host().agents).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
});

it("tells the host only when the Bestie or its community changes", async () => {
  const { relay, reconnect } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  changed.mockClear();
  // Other view state in the community, such as a draft, isn't a change.
  writeView(SCOPE, "composer:draft", "hello");
  expect(changed).not.toHaveBeenCalled();
  // A new session in another community is.
  reconnect(`https://other.example:${OWNER}`);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(tab.when?.(ada)).toBe(false);
  stop?.();
});

it("turns memory on and off as a marked section of the instructions", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const base = { instructions: "head-1" };
  const agent = {
    ...ada,
    config: { model: "m", instructions: "Be brief." },
    configBase: base,
  } as Agent;
  const { rerender } = render(<Tab agent={agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).not.toBeChecked();
  expect(
    screen.getByText(/Nothing Bestie remembered is deleted/),
  ).toBeVisible();

  await user.click(remembers);
  const on = withFeature("Be brief.", memory, true);
  // Revises the head the tab showed, keeping the rest of the config.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { model: "m", instructions: on },
    base,
  });
  expect(on).toMatch(
    /^Be brief\.\n\n<!-- buzz:bestie\/memory v1 -->\n# Memory\n/,
  );

  // The saved instructions are what the switch shows.
  rerender(
    <Tab agent={{ ...agent, config: { model: "m", instructions: on } }} />,
  );
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { model: "m", instructions: "Be brief." },
    base,
  });
});

it("keeps memory on through the owner's edits, and offers Restore for edited markers", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const base = { instructions: "head-2" };
  const on = withFeature("Be brief.", memory, true);
  const close = "<!-- /buzz:bestie/memory -->";
  const shown = (instructions: string) =>
    ({ ...ada, config: { instructions }, configBase: base }) as Agent;
  // Typed below the section, which lands on its closing marker's line.
  const typed = `${on} Also French.`;
  const { rerender } = render(<Tab agent={shown(typed)} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).toBeChecked();
  await user.click(remembers);
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { instructions: "Be brief.\n\nAlso French." },
    base,
  });

  // A closing marker edited by hand: no switch to add a second section.
  save.mockClear();
  const edited = on.replace(close, "<!-- /buzz:bestie/memory--> Also French.");
  rerender(<Tab agent={shown(edited)} />);
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  expect(screen.getByText(/edited where it starts or ends/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: `${on} Also French.` },
    base,
  });

  // With a marker gone, where the section ended is the owner's to say.
  rerender(<Tab agent={shown(on.replace(close, ""))} />);
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByText(/Fix its start and end lines there/)).toBeVisible();
});

it("says why a save failed and lets the switch be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  save.mockRejectedValueOnce(new Error("Connect to the community to save"));
  const Tab = bestieTab(relay, agents).component;
  render(<Tab agent={{ ...ada, config: {} } as Agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  await user.click(remembers);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connect to the community to save",
  );
  expect(remembers).not.toBeChecked();
  expect(remembers).not.toHaveAttribute("aria-disabled", "true");
  // A config with no instructions yet gets the section alone.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: withFeature("", memory, true) },
  });
});

it("offers no switch while the agent's instructions can't be read here", () => {
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  render(
    <Tab
      agent={
        {
          ...ada,
          config: {},
          configProblem: "This agent's instructions could not be read",
        } as Agent
      }
    />,
  );
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  expect(
    screen.getByText("This agent's instructions could not be read"),
  ).toBeVisible();
  expect(save).not.toHaveBeenCalled();
});
