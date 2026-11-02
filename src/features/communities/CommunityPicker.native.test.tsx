// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { nativeIdentityEnabled } from "../identity/service";
import { CommunityPicker } from "./CommunityPicker";
import type { Communities, ClientSnapshot } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
const settingsCards = {
  subscribe: () => () => {},
  has: () => true,
};
const viewer = "a".repeat(64);
const primary = "https://primary.example";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("offers native owners invites while keeping unsupported read sync disabled", async () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: { known: [], outbox: [] },
    viewer,
    selected: primary,
    memberships: [{ id: primary, name: "Primary" }],
  };
  const relayAuthor = "f".repeat(64);
  const read = vi.fn(async () => [
    {
      id: "e".repeat(64),
      kind: 13534,
      pubkey: relayAuthor,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["-"], ["member", viewer, "owner"]],
    },
  ]);
  const markAllChannelsRead = vi.fn(async () => []);
  const connection = {
    status: "ready",
    generation: 1,
    scope: `${primary}:${viewer}`,
    viewer,
    session: {
      relayAuthor,
      read,
      unread: {
        // Native builds have no read-state host, so the capability never syncs.
        sync: () => ({ capability: "unsupported" }),
        subscribeSync: () => () => {},
        markAllChannelsRead,
      },
    },
  } as unknown as RelaySnapshot;
  const communities = {
    retainPresentation: () => () => {},
    snapshot: () => snapshot,
    subscribe: () => () => {},
    select: vi.fn(),
    relay: {
      snapshot: () => connection,
      subscribe: () => () => {},
    } as unknown as RelayData,
  } as unknown as Communities;
  const onOpenTarget = vi.fn();
  render(
    <CommunityPicker
      communities={communities}
      onOpenTarget={onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Community switcher: Primary" }),
  );
  fireEvent.contextMenu(
    await screen.findByRole("button", { name: "Switch to Primary" }),
    {
      clientX: 20,
      clientY: 20,
    },
  );
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  expect(
    within(menu).queryByRole("menuitem", { name: "Community settings" }),
  ).toBeNull();
  const invite = await within(menu).findByRole("menuitem", {
    name: "Invite to community",
  });
  expect(invite).not.toHaveAttribute("aria-disabled");
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Read state can’t sync on this connection.",
  );
  expect(read).toHaveBeenCalledWith(
    [{ kinds: [13534], authors: [relayAuthor], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  // Leaving is offered in native builds too, always as the last action.
  const actions = within(menu).getAllByRole("menuitem");
  expect(actions.at(-1)).toHaveTextContent("Leave community");
  expect(actions.at(-1)).not.toHaveAttribute("aria-disabled");
  fireEvent.click(invite);
  expect(onOpenTarget).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "buzz.moderation/membership",
    scope: { viewer, communityOrigin: primary },
  });
});
