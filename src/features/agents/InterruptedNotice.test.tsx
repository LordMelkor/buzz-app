// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { InterruptedNotice } from "./InterruptedNotice";
import type { Agent, Agents, AgentsSnapshot } from "./service";

afterEach(cleanup);

/** Agents as far as the notice uses it. */
function fake(names: readonly string[]) {
  let state: AgentsSnapshot = {
    status: "ready",
    classifier: "unavailable",
    agents: [],
    running: [],
    interrupted: names.map((name) => ({ name }) as Agent),
    teams: [],
  };
  const listeners = new Set<() => void>();
  const forget = () => {
    state = { ...state, interrupted: [] };
    for (const listener of listeners) listener();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resumeInterrupted: vi.fn(forget),
    dismissInterrupted: vi.fn(forget),
  };
  render(
    <ToastProvider>
      <InterruptedNotice agents={agents as unknown as Agents} />
    </ToastProvider>,
  );
  return agents;
}

it("asks before resuming the agents the app stopped, and goes once answered", async () => {
  const agents = fake(["Echo", "Claude"]);
  await screen.findByRole("dialog", { name: "Resume interrupted agents?" });
  expect(
    screen.getByText(
      "Echo and Claude were working when Buzz closed or reloaded.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /dismiss/i }),
  ).not.toBeInTheDocument();
  act(() => fireEvent.click(screen.getByRole("button", { name: "Resume" })));
  expect(agents.resumeInterrupted).toHaveBeenCalledOnce();
  expect(agents.dismissInterrupted).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("forgets them when the owner does not resume", async () => {
  const agents = fake(["Echo"]);
  await screen.findByRole("dialog", { name: "Resume interrupted agent?" });
  expect(
    screen.getByText("Echo was working when Buzz closed or reloaded."),
  ).toBeVisible();
  act(() =>
    fireEvent.click(screen.getByRole("button", { name: "Don’t resume" })),
  );
  expect(agents.dismissInterrupted).toHaveBeenCalledOnce();
  expect(agents.resumeInterrupted).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("shows nothing when no agent was stopped", () => {
  fake([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
