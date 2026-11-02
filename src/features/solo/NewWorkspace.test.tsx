// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  parseKitRecord,
  type KitEntry,
  type Template,
} from "../channel-templates/model";
import { NewWorkspace } from "./NewWorkspace";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// This is the dialog's orchestration boundary: a project write and a separate
// defaults write can each fail. Protocol validation belongs to the real kit tests.
it("keeps a partially saved project frozen and reconciles its saved defaults on retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entries: KitEntry[] = [];
  const create = vi.fn(async () => {});
  const save = vi.fn(async (template: Template) => {
    await gate;
    entries = [
      {
        record: parseKitRecord(
          { version: 1, community: "", deleted: false, value: template },
          "",
        ),
        eventId: "saved",
        createdAt: 1,
      },
    ];
    throw new Error("Save not confirmed");
  });
  const close = vi.fn();
  render(
    <NewWorkspace
      create={create}
      close={close}
      onCreated={vi.fn()}
      session={
        {
          scope: "https://relay.example.test:viewer",
          channelKit: {
            refresh: async () => {},
            snapshot: () => ({ status: "ready", entries }),
            save,
          },
        } as unknown as RelaySession
      }
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Keep changes small" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  try {
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    for (const closeButton of screen.getAllByRole("button", {
      name: "Close",
    }))
      expect(closeButton).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: /^Instructions/ }),
    ).toBeDisabled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("textbox", { name: /^Folders/ })).toBeDisabled();
  } finally {
    release();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save not confirmed",
  );
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep changes small",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Name, folders and instructions are kept for the retry.",
  );
  // A stray outside click keeps the retry state and its workspace identity.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep changes small",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
});

it("rejects oversized defaults with their real community envelope before creating anything", async () => {
  const create = vi.fn(async () => {});
  render(
    <NewWorkspace
      create={create}
      close={vi.fn()}
      onCreated={vi.fn()}
      session={{ scope: "https://relay.example.test:viewer" } as RelaySession}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "a".repeat(16_095) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("16 KiB");
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled();
});

it("offers only Close when the saved project defaults were changed elsewhere", async () => {
  let entries: KitEntry[] = [];
  const save = vi.fn(async (template: Template) => {
    entries = [
      {
        record: parseKitRecord(
          {
            version: 1,
            community: "https://relay.example.test",
            deleted: false,
            value: { ...template, canvas: "Changed elsewhere" },
          },
          "https://relay.example.test",
        ),
        eventId: "changed",
        createdAt: 1,
      },
    ];
    throw new Error("Save not confirmed");
  });
  const close = vi.fn();
  render(
    <NewWorkspace
      create={vi.fn(async () => {})}
      close={close}
      onCreated={vi.fn()}
      session={
        {
          scope: "https://relay.example.test:viewer",
          channelKit: {
            refresh: async () => {},
            snapshot: () => ({ status: "ready", entries }),
            save,
          },
        } as unknown as RelaySession
      }
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Keep changes small" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save not confirmed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Workspace defaults changed",
    ),
  );
  expect(
    screen.queryByRole("button", { name: /^(Create|Retry)$/ }),
  ).not.toBeInTheDocument();
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Close", { selector: "button span" }));
  expect(close).toHaveBeenCalledOnce();
});
