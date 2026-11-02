// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoadingRegion } from "./LoadingRegion";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("delays screen-reader status without a visible row and shows errors immediately", async () => {
  vi.useFakeTimers();
  const content = (pending: boolean, error = false) => (
    <LoadingRegion
      pending={pending}
      label="Loading settings…"
      statusVisibility="screen-reader"
      feedback={error ? <p role="alert">Read failed. Retry.</p> : undefined}
    >
      <button type="button">Existing content</button>
    </LoadingRegion>
  );
  const view = render(content(true));
  const button = screen.getByRole("button");
  const region = button.parentElement;
  expect(region).toHaveAttribute("aria-busy", "true");
  expect(region?.querySelector(".buzz-loading-region-feedback")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByRole("status")).toHaveClass("sr-only");
  expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
  view.rerender(content(false));
  expect(region).toHaveAttribute("aria-busy", "false");
  expect(screen.queryByRole("status")).toBeNull();
  expect(region?.querySelector(".buzz-loading-region-feedback")).toBeNull();
  view.rerender(content(true, true));
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed. Retry.");
  expect(screen.getByRole("button")).toBe(button);
});

it("keeps content mounted, announces only sustained loading, and never holds up completion", async () => {
  vi.useFakeTimers();
  const content = (pending: boolean) => (
    <LoadingRegion pending={pending} label="Loading profile…">
      <button type="button">Existing content</button>
    </LoadingRegion>
  );
  const view = render(content(true));
  const button = screen.getByRole("button");
  expect(button.parentElement).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(content(false));
  expect(screen.getByRole("button")).toBe(button);
  expect(button.parentElement).toHaveAttribute("aria-busy", "false");
  view.rerender(content(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Loading profile…");
  view.rerender(content(false));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button")).toBe(button);
  view.rerender(
    <LoadingRegion
      pending={false}
      label="Loading profile…"
      feedback={<p role="alert">Read failed. Retry.</p>}
    >
      <button type="button">Existing content</button>
    </LoadingRegion>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed. Retry.");
  expect(screen.getByRole("button")).toBe(button);
});
