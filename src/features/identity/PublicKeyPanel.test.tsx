// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PublicKeyPanel } from "./PublicKeyPanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const npub = `npub1${"q".repeat(58)}`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("copies through the host clipboard in the macOS app and confirms inline", async () => {
  // Host script evaluation clears WebKit's transient activation, so the
  // desktop app must not write through navigator.clipboard.
  // userEvent.setup() installs jsdom's missing navigator.clipboard.
  const user = userEvent.setup();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.mocked(invoke).mockResolvedValue(undefined);
  const browserWrite = vi.spyOn(navigator.clipboard, "writeText");
  render(<PublicKeyPanel publicKey={npub} />);
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(invoke).toHaveBeenCalledWith("clipboard_write_text", { text: npub });
  expect(browserWrite).not.toHaveBeenCalled();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Public key copied.",
  );
});

it("points at the selectable key when the clipboard write is refused", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("denied", "NotAllowedError"),
  );
  render(<PublicKeyPanel publicKey={npub} />);
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(invoke).not.toHaveBeenCalled();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Could not copy. Select the key above to copy it.",
  );
});
