// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import {
  AgentCommunityScope,
  useAgentScopeCommunity,
  type AgentScopeReader,
} from "./AgentCommunityScope";

afterEach(cleanup);

it.each(["Memory", "Avatar"] as const)(
  "%s scope follows this agent's remaining memberships, including offline ones",
  async (scope) => {
    const user = userEvent.setup();
    const agent = {
      pubkey: "a".repeat(64),
      relay: "wss://current.example",
      place: "here" as const,
    };
    const current = { key: agent.pubkey, origin: agent.relay, connected: true };
    const other = {
      key: "other",
      origin: "https://other.example",
      connected: false,
    };
    let memberships: ReturnType<AgentScopeReader["memberships"]> = [current];
    const listeners = new Set<() => void>();
    const agents: AgentScopeReader = {
      memberships: (pubkey) => {
        expect(pubkey).toBe(agent.pubkey);
        return [...memberships];
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const update = (next: typeof memberships) =>
      act(() => {
        memberships = next;
        for (const listener of listeners) listener();
      });
    function View() {
      const community = useAgentScopeCommunity(agent, agents, undefined);
      return <AgentCommunityScope scope={scope} community={community} />;
    }
    const view = render(<View />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    update([current, { ...other, deleting: true }]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    update([current, other]);
    const trigger = screen.getByRole("button", {
      name:
        scope === "Avatar"
          ? "Only in current.example"
          : `${scope} scope: current.example`,
    });
    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: `${scope} scope` }),
    ).toBeVisible();
    update([current]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: `${scope} scope` }),
    ).not.toBeInTheDocument();
    view.unmount();
    expect(listeners.size).toBe(0);
  },
);
