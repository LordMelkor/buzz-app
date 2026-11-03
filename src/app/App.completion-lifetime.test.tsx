// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

vi.mock("../bundled", () => ({ bundledPlugins: [] }));

let services: AppServices | undefined;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const toastRoot = document.createElement("div");
  toastRoot.id = "buzz-toast-root";
  document.body.append(toastRoot);
});

afterEach(async () => {
  cleanup();
  document.getElementById("buzz-toast-root")?.remove();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("observes live Solo completions through community restoration without replaying settled work", async () => {
  const activity = createLocalAgentActivity();
  const settled = activity.begin({
    scope: `https://community.example:${"a".repeat(64)}`,
    agent: "agent",
    channelId: "old-chat",
    messageId: "old-message",
    threadRootId: "old-message",
    soloChat: true,
    conversationName: "Old chat",
  });
  settled.started();
  settled.finish({ ok: true });

  const current = createServices();
  services = current;
  let snapshot = current.relay.snapshot();
  const listeners = new Set<() => void>();
  const relay = {
    ...current.relay,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = current.relay.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  };
  const appServices = {
    ...current,
    agentActivity: activity.reader,
    relay,
  } satisfies AppServices;

  render(<App services={appServices} />);
  expect(screen.queryByText(/Old chat/)).not.toBeInTheDocument();

  const live = activity.begin({
    scope: `https://community.example:${"a".repeat(64)}`,
    agent: "agent",
    channelId: "live-chat",
    messageId: "live-message",
    threadRootId: "live-message",
    soloChat: true,
    conversationName: "Live chat",
  });
  live.started();

  act(() => {
    snapshot = { ...current.relay.snapshot(), restoring: true };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("status", { name: "Opening Buzz" }),
  ).toBeInTheDocument();

  act(() => live.finish({ ok: true }));
  expect(await screen.findByText("Agent is done in Live chat")).toBeVisible();
  expect(screen.queryByText(/Old chat/)).not.toBeInTheDocument();

  act(() => {
    snapshot = current.relay.snapshot();
    for (const listener of listeners) listener();
  });
  expect(screen.getAllByText("Agent is done in Live chat")).toHaveLength(1);
});
