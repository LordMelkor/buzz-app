// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunities } from "../features/communities/service";
import {
  readRepositoriesFolder,
  repositoriesKey,
  saveRepositoriesFolder,
} from "../features/communities/repositories";
import { CommunityRepositoriesSettings } from "./CommunityRepositoriesSettings";

const native = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => native.desktop,
}));
const viewer = "a".repeat(64);
const community = "https://community.example";
const roots: Context[] = [];
async function setup() {
  const root = new Context();
  roots.push(root);
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  await act(async () => {
    await Promise.resolve();
  });
  communities.joined(
    { id: community, name: "Community" },
    { name: "You", picture: "" },
  );
  const view = render(
    <CommunityRepositoriesSettings
      communities={communities}
      community={community}
      viewer={viewer}
    />,
  );
  return { view, communities, user: userEvent.setup() };
}
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
  native.invoke.mockReset();
  native.desktop = true;
});

it("validates and saves a chosen folder, preserves drafts on failure, and restores the default without touching other accounts", async () => {
  const { user } = await setup();
  saveRepositoriesFolder(community, "b".repeat(64), "/other");
  native.invoke.mockResolvedValueOnce("~/Development");
  await user.click(screen.getByRole("button", { name: "Choose folder…" }));
  expect(screen.getByLabelText("Repositories folder")).toHaveValue(
    "~/Development",
  );
  expect(readRepositoriesFolder(community, viewer)).toBe("");
  native.invoke.mockRejectedValueOnce(
    "The repositories folder is unavailable.",
  );
  await user.click(screen.getByRole("button", { name: "Save folder" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
  expect(screen.getByLabelText("Repositories folder")).toHaveValue(
    "~/Development",
  );
  expect(screen.queryByRole("status")).toBeNull();
  native.invoke.mockResolvedValueOnce("/Users/you/Development");
  await user.click(screen.getByRole("button", { name: "Save folder" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Repositories folder saved on this device. Claude and Goose use it in new sessions; Codex uses it on future turns.",
  );
  expect(readRepositoriesFolder(community, viewer)).toBe(
    "/Users/you/Development",
  );
  await user.click(screen.getByRole("button", { name: "Restore default" }));
  await waitFor(() =>
    expect(localStorage.getItem(repositoriesKey(community, viewer))).toBeNull(),
  );
  expect(readRepositoriesFolder(community, "b".repeat(64))).toBe("/other");
});

it.each(["picker", "typed"])(
  "saves the native home-directory result from a %s selection",
  async (source) => {
    const { user } = await setup();
    const input = screen.getByLabelText("Repositories folder");
    if (source === "picker") {
      native.invoke.mockResolvedValueOnce("~");
      await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    } else {
      await user.type(input, "/Users/you");
    }
    native.invoke.mockResolvedValueOnce("~");
    await user.click(screen.getByRole("button", { name: "Save folder" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "saved on this device",
    );
    expect(input).toHaveValue("~");
    expect(readRepositoriesFolder(community, viewer)).toBe("~");
  },
);

it("blocks a late native result after community removal and keeps dirty drafts through another window’s change", async () => {
  const { user, communities } = await setup();
  const input = screen.getByLabelText("Repositories folder");
  await user.type(input, "/draft");
  act(() => {
    saveRepositoriesFolder(community, viewer, "/other-window");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: repositoriesKey(community, viewer),
        storageArea: localStorage,
      }),
    );
  });
  expect(input).toHaveValue("/draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input).toHaveValue("/other-window");
  await user.clear(input);
  await user.type(input, "/new-draft");
  let release!: (path: string) => void;
  native.invoke.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save folder" }));
  expect(screen.getByRole("button", { name: "Save folder" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  try {
    await act(async () => {
      await communities.leave(community, { purge: false });
    });
  } finally {
    await act(async () => {
      release("/validated");
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "community changed",
  );
  expect(readRepositoriesFolder(community, viewer)).toBe("/other-window");
  expect(input).toHaveValue("/new-draft");
});

it("does not offer unsupported browser filesystem writes", async () => {
  native.desktop = false;
  await setup();
  expect(screen.getByLabelText("Repositories folder")).toHaveAttribute(
    "readonly",
  );
  expect(screen.queryByRole("button", { name: "Save folder" })).toBeNull();
  expect(native.invoke).not.toHaveBeenCalled();
});
