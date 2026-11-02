// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { WorkspaceControl } from "./WorkspaceControl";

afterEach(cleanup);

function fixture() {
  const assign = vi.fn(async () => {});
  const snapshot = {
    status: "ready" as const,
    data: {
      sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
      assignments: { chat: "buzz" },
      starred: [],
      muted: [],
    },
  };
  const session = {
    soloPreferences: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      assign,
      refresh: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  return { session, assign };
}

it("moves a saved chat without changing project defaults", async () => {
  const { session, assign } = fixture();
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Workspace: Buzz App" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No workspace" }),
  );
  expect(assign).toHaveBeenCalledWith("chat", undefined);
});

it("changes a new-chat project locally instead of moving a saved channel", async () => {
  const { session, assign } = fixture();
  const change = vi.fn();
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={change} />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Buzz App" }),
  );
  expect(change).toHaveBeenCalledWith("buzz");
  expect(assign).not.toHaveBeenCalled();
});

it("keeps project recovery reachable after preferences fail", async () => {
  const refresh = vi.fn(async () => {});
  const session = {
    soloPreferences: {
      snapshot: () => ({ status: "error", error: "Projects unavailable" }),
      subscribe: () => () => {},
      assign: vi.fn(async () => {}),
      refresh,
    },
  } as unknown as RelaySession;
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Retry workspaces" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});
