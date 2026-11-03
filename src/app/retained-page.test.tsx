// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageProps } from "../features/pages/service";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

// The page acknowledges only while `answer` is set; otherwise it stays silent.
const page = vi.hoisted(() => ({ answer: true }));
function Held({ navigation }: PageProps) {
  useEffect(() => {
    if (page.answer) navigation?.complete({ status: "opened" });
  }, [navigation]);
  return <p>Held content</p>;
}
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.held", name: "Held", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
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
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "timeout",
    });
  });
  expect(screen.getByText("Held content")).toBeVisible();
  // The page's own lookup fails after the deadline.
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
