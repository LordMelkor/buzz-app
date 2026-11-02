// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { WorkspaceFields } from "./WorkspaceFields";
import type { Workspace } from "./workspace";
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));
beforeEach(() => vi.mocked(isTauri).mockReturnValue(true));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function Form({ folders = ["~/original"] }: { folders?: string[] }) {
  const [value, setValue] = useState<Workspace>({
    folders,
    worktree: { location: "~/worktrees", baseBranch: "main" },
    canvas: "Keep this",
  });
  return <WorkspaceFields value={value} onChange={setValue} />;
}
it("adds a picked folder, preserves other fields, ignores cancellation and duplicates", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("~/chosen")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("~/chosen");
  render(<Form />);
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "Add folder…" });
  await user.click(add);
  expect(invoke).toHaveBeenCalledWith("workspace_pick_folder", {
    title: "Add a folder",
  });
  expect(screen.getByRole("button", { name: "Remove chosen" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep this",
  );
  expect(add).toHaveFocus();
  await user.click(add);
  expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
  await user.click(add);
  expect(await screen.findByRole("alert")).toHaveTextContent("Already added.");
  expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
});
it("removing a folder moves focus to the next remove button, then to Add", async () => {
  vi.mocked(invoke).mockResolvedValueOnce("~/second");
  render(<Form />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add folder…" }));
  await user.click(screen.getByRole("button", { name: "Remove original" }));
  expect(screen.getByRole("button", { name: "Remove second" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Remove second" }));
  expect(screen.getByRole("button", { name: "Add folder…" })).toHaveFocus();
});
it("opens the worktree picker at the current location and keeps it when the picker fails", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Picker unavailable"));
  render(<Form />);
  const location = screen.getByRole("button", {
    name: "Worktree location: ~/worktrees",
  });
  await userEvent.setup().click(location);
  expect(invoke).toHaveBeenCalledWith("workspace_pick_folder", {
    title: "Choose a worktree location",
    start: "~/worktrees",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Picker unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Worktree location: ~/worktrees" }),
  ).toBeEnabled();
  expect(location).toHaveFocus();
});
