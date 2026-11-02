// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import { readView, writeView } from "../../shared/view-state";
import { ChannelGeneralAccess } from "./ChannelGeneralAccess";
import { CreateChannelDialog } from "./CreateChannelDialog";
import {
  skipPrivacyConfirmation,
  rememberPrivacyConfirmation,
} from "./ChannelPrivacyConfirmation";

const scope = "community:viewer";
const store = createRelaySession(null);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function access(visibility: "public" | "private") {
  const channel = { id: "alpha", name: "Alpha", description: "", visibility };
  const base = {
    ...channel,
    channelId: channel.id,
    version: "v1",
    canEdit: true,
  };
  const save = vi.fn(async () => {});
  const capability: ChannelDetailsCapability = {
    available: true,
    load: vi.fn(async () => base),
    save,
    check: vi.fn(async () => {}),
    snapshot: () => undefined,
    subscribe: () => () => {},
  };
  return {
    save,
    element: (
      <ChannelGeneralAccess channelId={channel.id} capability={capability} />
    ),
  };
}

it.each(["private", "public"] as const)(
  "opting out from %s skips Create warnings after reopening; General access still confirms immediate writes",
  async (choice) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const create = (
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        session={{ ...store.session, scope }}
        destinations={[]}
        initialGroup=""
        groupsReady
      />
    );
    const view = render(create);
    if (choice === "public") {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Don’t show me this again" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(skipPrivacyConfirmation(scope)).toBe(true);
    const opposite = choice === "private" ? "public" : "private";

    view.unmount();
    const reopened = render(create);
    // Every toggle stays in the form, including the opposite direction.
    for (const checked of [true, false]) {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      expect(screen.getByRole("dialog")).toHaveAccessibleName(
        "Create a channel",
      );
      expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
        "aria-checked",
        String(checked),
      );
    }
    if (choice === "public")
      await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(screen.getByRole("switch", { name: "Private" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
    expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
      "aria-checked",
      String(choice === "private"),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "new-channel" },
    });
    expect(onCreate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "new-channel",
      visibility: choice === "private" ? "private" : "open",
    });
    reopened.unmount();

    const edit = access(opposite);
    render(edit.element);
    const control = await screen.findByRole("combobox", {
      name: "General access",
    });
    await vi.waitFor(() => expect(control).toBeEnabled());
    await user.click(control);
    await user.click(
      await screen.findByRole("option", {
        name: choice === "private" ? "Private" : "Public",
      }),
    );
    expect(
      screen.getByRole("alertdialog", { name: "Change general access?" }),
    ).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(edit.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(control).toHaveFocus());
    expect(edit.save).not.toHaveBeenCalled();
  },
);

it.each(["private", "public"] as const)(
  "remembers a Create %s warning only after Continue and isolates community/viewer scope",
  async (choice) => {
    const user = userEvent.setup();
    const create = (currentScope: string) => (
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={async () => {}}
        session={{ ...store.session, scope: currentScope }}
        destinations={[]}
        initialGroup=""
        groupsReady
      />
    );
    const view = render(create(scope));
    if (choice === "public") {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Don’t show me this again" }),
    );
    expect(skipPrivacyConfirmation(scope)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(skipPrivacyConfirmation(scope)).toBe(false);
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Don’t show me this again" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(skipPrivacyConfirmation(scope)).toBe(true);
    view.unmount();
    for (const otherScope of [
      "other-community:viewer",
      "community:other-viewer",
    ]) {
      const other = render(create(otherScope));
      await user.click(screen.getByRole("switch", { name: "Private" }));
      expect(
        screen.getByRole("dialog", { name: "Make channel private?" }),
      ).toBeVisible();
      other.unmount();
    }
  },
);

it("fails safe on corrupt or unavailable preference storage", () => {
  const key = "channel-privacy-confirmation:dismissed";
  for (const invalid of ["true", 1, {}, [true], null]) {
    writeView(scope, key, invalid);
    expect(skipPrivacyConfirmation(scope)).toBe(false);
  }
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(() => rememberPrivacyConfirmation(scope)).not.toThrow();
  expect(readView(scope, key, false)).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(skipPrivacyConfirmation(scope)).toBe(false);
});

it.each(["private", "public"])(
  "honors an existing %s opt-out for both directions",
  (choice) => {
    writeView(scope, `channel-privacy-confirmation:${choice}:dismissed`, true);
    expect(skipPrivacyConfirmation(scope)).toBe(true);
    expect(skipPrivacyConfirmation("other-community:viewer")).toBe(false);
    expect(skipPrivacyConfirmation("community:other-viewer")).toBe(false);
  },
);
