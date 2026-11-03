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

function start() {
  const target = {
    version: 1,
    kind: "page",
    pluginId: "test.held",
    pageId: "held",
  };
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
