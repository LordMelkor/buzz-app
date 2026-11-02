// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { KeyState } from "./key";
import { TypeSafeSettings } from "./TypeSafeSettings";

afterEach(cleanup);

/** The key as the form uses it, with a store that can fail. */
function fake(desktop = true, keyState: KeyState = "missing") {
  const listeners = new Set<() => void>();
  const set = (next: KeyState) => {
    keyState = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => keyState,
    desktop: () => desktop,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    save: vi.fn(async (_key: string) => set("saved")),
    clear: vi.fn(async () => set("missing")),
  };
}

it("asks for the TypeSafe key", () => {
  render(<TypeSafeSettings typesafe={fake()} active={() => true} />);
  expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
});

it("asks for the desktop app in the browser", () => {
  render(<TypeSafeSettings typesafe={fake(false)} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
});

it("saves a key without showing it again, and removes it", async () => {
  const user = userEvent.setup();
  const typesafe = fake();
  render(<TypeSafeSettings typesafe={typesafe} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Add your TypeSafe API key",
  );
  const input = screen.getByLabelText("TypeSafe API key");
  expect(input).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  await user.type(input, "  tk-secret  ");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(typesafe.save).toHaveBeenCalledWith("tk-secret");
  expect(input).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Your TypeSafe key is saved",
  );
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(typesafe.clear).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Add your TypeSafe API key",
  );
});

it("keeps the typed key and shows why a save failed", async () => {
  const user = userEvent.setup();
  const typesafe = fake();
  typesafe.save.mockRejectedValueOnce(
    new Error("That does not look like a TypeSafe API key"),
  );
  render(<TypeSafeSettings typesafe={typesafe} active={() => true} />);
  await user.type(screen.getByLabelText("TypeSafe API key"), "bad key");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not look like",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("bad key");
});

it("does not call a key missing until its status is read, or when it cannot be", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <TypeSafeSettings typesafe={fake(true, "checking")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  const unreadable = fake(true, "unreadable");
  rerender(<TypeSafeSettings typesafe={unreadable} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("could not read");
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(unreadable.clear).toHaveBeenCalledOnce();
  rerender(
    <TypeSafeSettings typesafe={fake(true, "refused")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "TypeSafe did not accept your key",
  );
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
});

it("warns that other programs can read the key only off Apple platforms", () => {
  const text = /Other programs you run, agent shells included, can read/;
  const { unmount } = render(
    <TypeSafeSettings typesafe={fake()} active={() => true} apple={false} />,
  );
  expect(screen.getByText(text)).toBeVisible();
  unmount();
  render(<TypeSafeSettings typesafe={fake()} active={() => true} apple />);
  expect(screen.queryByText(text)).not.toBeInTheDocument();
});
