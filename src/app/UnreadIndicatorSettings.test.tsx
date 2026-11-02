// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createUnreadIndicator,
  type IndicatorPermission,
} from "../features/notifications/indicator";
import { UnreadIndicatorSettings } from "./UnreadIndicatorSettings";

const native = vi.hoisted(() => ({ value: true }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  native.value = true;
});
function setup(initial: IndicatorPermission) {
  const permission = vi.fn(async (): Promise<IndicatorPermission> => initial);
  const dock = createUnreadIndicator({
    permission,
    set: vi.fn(async () => {}),
  });
  cleanups.push(dock.dispose);
  render(<UnreadIndicatorSettings indicator={dock} />, {
    wrapper: ToastProvider,
  });
  return { permission, dock };
}
it("requests permission only through the explicit Settings button and updates status", async () => {
  const h = setup("default");
  await act(() => h.dock.refresh());
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(screen.getByText(/doesn’t show a message count/)).toBeInTheDocument();
  let resolve!: (permission: IndicatorPermission) => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Allow notifications and badges" }),
  );
  expect(
    screen.getByRole("button", { name: "Allow notifications and badges" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Waiting for system permission…"),
  ).toBeInTheDocument();
  await act(async () => {
    resolve("enabled");
    await h.dock.refresh();
  });
  expect(screen.getByText("Buzz can show Dock badges.")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Allow notifications and badges" }),
  ).not.toBeInTheDocument();
});
it.each(["disabled", "denied"] as const)(
  "offers only a permission refresh over %s",
  async (permission) => {
    const h = setup(permission);
    await act(() => h.dock.refresh());
    expect(
      screen.queryByRole("button", { name: "Allow notifications and badges" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check Dock permission" }));
    expect(h.permission.mock.calls).toEqual([[false], [false]]);
  },
);

it("keeps an immediately unchanged Dock check visibly busy", async () => {
  const h = setup("enabled");
  await act(() => h.dock.refresh());
  vi.useFakeTimers();
  const button = screen.getByRole("button", { name: "Check Dock permission" });
  button.focus();
  await act(async () => {
    button.click();
  });
  expect(h.permission.mock.calls).toEqual([[false], [false]]);
  expect(screen.getByText("Buzz can show Dock badges.")).toBeInTheDocument();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toHaveAttribute("disabled");
  expect(button).toHaveFocus();
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(button).not.toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAccessibleName("Check Dock permission");
  expect(button).toHaveFocus();
});

it("shows no dead permission actions when Dock badges are unavailable", async () => {
  const h = setup("unavailable");
  await act(() => h.dock.refresh());
  expect(
    screen.getByRole("heading", { name: "Dock unread badge" }),
  ).toBeVisible();
  expect(
    screen.getByText(/Dock badges require a bundled macOS app/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(h.permission.mock.calls).toEqual([[false]]);
});

it("offers missing-badge setup only as an explicit action", async () => {
  const h = setup("setup");
  await act(() => h.dock.refresh());
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(
    screen.queryByRole("button", { name: "Allow notifications and badges" }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Set up Dock badges" }));
  expect(h.permission.mock.calls).toEqual([[false], [true]]);
});
it.each([
  [true, "Win32"],
  [false, "MacIntel"],
] as const)(
  "hides Dock settings and makes no IPC calls for native=%s platform=%s",
  async (tauri, platform) => {
    native.value = tauri;
    vi.stubGlobal("navigator", { platform });
    const indicator = createUnreadIndicator();
    cleanups.push(indicator.dispose);
    const { container } = render(
      <UnreadIndicatorSettings indicator={indicator} />,
    );
    await act(async () => {
      indicator.setUnread(true);
      await indicator.refresh();
      await indicator.request();
      await indicator.dispose();
    });
    expect(container).toBeEmptyDOMElement();
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("shows a Dock write error and retries through the existing permission check", async () => {
  const set = vi.fn(async (_unread: boolean) => {});
  const indicator = createUnreadIndicator({
    permission: async () => "enabled",
    set,
  });
  cleanups.push(indicator.dispose);
  render(<UnreadIndicatorSettings indicator={indicator} />, {
    wrapper: ToastProvider,
  });
  await act(() => indicator.refresh());
  set.mockRejectedValueOnce(new Error("Dock unavailable"));
  await act(async () => {
    indicator.setUnread(true);
  });
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Dock unavailable",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check Dock permission" }));
  expect(set).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
