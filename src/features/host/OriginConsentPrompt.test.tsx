// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { OriginConsentPrompt } from "./OriginConsentPrompt";
import { askOriginConsent, originConsent } from "./origin-consent";

afterEach(() => {
  cleanup();
  originConsent.declineAll();
});

const ask = (origin = "https://mcp.example") =>
  askOriginConsent(
    { plugin: { id: "example.mcp", name: "MCP servers" }, origin },
    new AbortController().signal,
  );

it("names the plugin and the exact origin, with Deny focused", async () => {
  render(<OriginConsentPrompt />);
  const answer = act(() => ask("https://mcp.example:8443"));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Let MCP servers connect to this address?");
  expect(dialog).toHaveTextContent("https://mcp.example:8443");
  expect(dialog).toHaveTextContent("example.mcp");
  await expect
    .poll(() => screen.getByRole("button", { name: "Deny" }))
    .toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(await answer).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("declines on Deny and on Escape, then asks the next question", async () => {
  render(<OriginConsentPrompt />);
  const first = ask("https://one.example");
  const second = ask("https://two.example");
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(await first).toBe(false);
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "https://two.example",
  );
  await userEvent.keyboard("{Escape}");
  expect(await second).toBe(false);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("declines what is waiting when the page goes away", async () => {
  const view = render(<OriginConsentPrompt />);
  const answer = ask();
  await screen.findByRole("alertdialog");
  view.unmount();
  expect(await answer).toBe(false);
});

it("puts focus back on Deny for a repeat of the same question", async () => {
  render(<OriginConsentPrompt />);
  void ask();
  void ask();
  const deny = () => screen.getByRole("button", { name: "Deny" });
  await expect.poll(deny).toHaveFocus();
  screen.getByRole("button", { name: "Allow" }).focus();
  act(() => originConsent.answer(false));
  await expect.poll(deny).toHaveFocus();
});
