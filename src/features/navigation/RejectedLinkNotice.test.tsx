// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRejectedLinks } from "./deep-links";
import { RejectedLinkNotice } from "./RejectedLinkNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows one notice per rejected link; a repeat restarts its expiry", async () => {
  vi.useFakeTimers();
  const links = createRejectedLinks();
  render(
    <ToastProvider>
      <RejectedLinkNotice links={links} />
    </ToastProvider>,
  );
  const notice = () =>
    screen.queryAllByRole("dialog", { name: "This link doesn’t work" });
  expect(notice()).toHaveLength(0);
  await act(async () => links.reject());
  await act(async () => vi.advanceTimersByTime(100));
  expect(notice()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(6000));
  await act(async () => links.reject());
  await act(async () => vi.advanceTimersByTime(6000));
  // Past the first notice's 8 s: the repeat replaced it and started over.
  expect(links.snapshot()).toBe(2);
  expect(notice()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(links.snapshot()).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(1000));
  expect(notice()).toHaveLength(0);
});
