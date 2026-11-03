// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageNavigation } from "../features/navigation/service";
import type { PageProps } from "../features/pages/service";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

// The page acknowledges only while `answer` is set; otherwise it stays silent.
// `gate` is a Settings card's authorization, which can still be loading.
const page = vi.hoisted(() => ({
  answer: true,
  gate: true as boolean | "pending",
  listeners: new Set<() => void>(),
  // The request the page last received, as the page itself holds it.
  navigation: undefined as PageNavigation | undefined,
}));
function setGate(gate: boolean | "pending") {
  page.gate = gate;
  for (const listener of page.listeners) listener();
}
function Held({ navigation }: PageProps) {
  useEffect(() => {
    page.navigation = navigation;
    if (page.answer) navigation?.complete({ status: "opened" });
  }, [navigation]);
  return <p>Held content</p>;
}
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.held", name: "Held", apiVersion: 1 },
      module: {
        inject: ["pages", "settingsCards"],
        apply(ctx: Context) {
          ctx.settingsCards.register({
            id: "gate",
            title: "Gated",
            group: "Test",
            visibility: {
              snapshot: () => page.gate,
              subscribe(listener) {
                page.listeners.add(listener);
                return () => page.listeners.delete(listener);
              },
              ensure: () => () => {},
            },
            component: () => <p>Gated controls</p>,
          });
          ctx.pages.register({
            id: "held",
            title: "Held",
            handlesNavigation: true,
            component: Held,
          });
        },
      },
    },
  ],
}));

beforeEach(() => {
  page.answer = true;
  page.gate = true;
  page.navigation = undefined;
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function start(
  target: Record<string, unknown> = {
    version: 1,
    kind: "page",
    pluginId: "test.held",
    pageId: "held",
  },
) {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}

it("keeps a shown page on screen when a background reopen times out", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // Something reopens the same visit without the person acting; the page
  // does not answer before the deadline.
  page.answer = false;
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    presented: true,
  });
  expect(screen.getByText("Held content")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "This page isn’t available" }),
  ).toBeNull();
});

it("still replaces the page when it reports its own failure", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "unavailable",
    });
  });
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByText("Held content")).toBeNull();
});

it("replaces a kept page when it reports its own failure after the deadline", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  const previous = page.navigation;
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  // The page receives the retry as a new request of its own.
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const request = page.navigation;
  if (!request) throw new Error("The page received no request");
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  expect(screen.getByText("Held content")).toBeVisible();
  // The page's own lookup fails after the deadline, through its own request.
  let accepted = false;
  act(() => {
    accepted = request.complete({ status: "failed", reason: "unavailable" });
  });
  expect(accepted).toBe(true);
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByText("Held content")).toBeNull();
});

it("rejects a kept page's late answer once another visit replaced it", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  const previous = page.navigation;
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  // The page receives the retry as a new request of its own.
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const stale = page.navigation;
  if (!stale) throw new Error("The page received no request");
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  expect(
    await screen.findByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // The old page's answer, address or failure, no longer reaches anything.
  let answers: boolean[] = [];
  act(() => {
    answers = [
      stale.resolve({ ...stale.target }),
      stale.complete({ status: "opened" }),
      stale.complete({ status: "failed", reason: "unavailable" }),
    ];
  });
  expect(answers).toEqual([false, false, false]);
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: { target: { kind: "settings" } },
  });
  expect(
    screen.queryByRole("heading", { name: "This page isn’t available" }),
  ).toBeNull();
});

it("keeps a shown Settings section when a background reopen times out", async () => {
  const current = start({
    version: 1,
    kind: "settings",
    section: "appearance",
  });
  expect(
    await screen.findByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // Settings answers each open at once, after its render; record every frame
  // in between so a card drawn for one commit is still caught.
  const frames = new MutationObserver(() => {});
  frames.observe(document.body, { childList: true, subtree: true });
  act(() => {
    void current.navigation.retry();
    current.navigationHost.complete(current.navigation.snapshot().attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  const added = frames
    .takeRecords()
    .flatMap((record) => [...record.addedNodes])
    .map((node) => node.textContent ?? "");
  frames.disconnect();
  expect(added.some((text) => text.includes("This page isn’t available"))).toBe(
    false,
  );
  expect(screen.getByRole("heading", { name: "Conversations" })).toBeVisible();
  // Its late answer reopens the visit.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});

it("shows the card when a kept timeout leaves only the loading state", async () => {
  const current = start({
    version: 1,
    kind: "settings",
    section: "test.held/gate",
  });
  expect(await screen.findByText("Gated controls")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // The section reopens while its authorization reloads: the host draws its
  // loading state instead of the editor, and the deadline passes.
  act(() => {
    setGate("pending");
    void current.navigation.retry();
  });
  expect(screen.queryByText("Gated controls")).toBeNull();
  act(() => {
    current.navigationHost.complete(current.navigation.snapshot().attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    presented: true,
  });
  expect(
    screen.getByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  // Once authorized, the section is drawn and its late answer reopens it.
  act(() => setGate(true));
  expect(await screen.findByText("Gated controls")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(
    screen.queryByRole("heading", { name: "This page isn’t available" }),
  ).toBeNull();
});
