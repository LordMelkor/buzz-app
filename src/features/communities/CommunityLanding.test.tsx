// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityLanding } from "./CommunityLanding";
import type { Communities } from "./service";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const communities = {
  snapshot: () => ({
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "", about: "" },
    memberships: [],
    selected: null,
  }),
} as unknown as Communities;

function landing({
  hosted = false,
  invite = undefined as
    | { community: string; code: string; requestId: number }
    | undefined,
} = {}) {
  const props = {
    onInviteClose: vi.fn(),
    onJoined: vi.fn(),
    onCreate: vi.fn(),
  };
  render(
    <CommunityLanding
      communities={communities}
      invite={invite}
      settingsCards={{ subscribe: () => () => {}, has: () => hosted }}
      {...props}
    />,
  );
  return props;
}

it("opens the join steps from a pasted invite page link", async () => {
  const user = userEvent.setup();
  landing();
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Create a community" }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example/invite/v2.invite",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeVisible();
  expect(screen.getByDisplayValue("https://relay.example")).toBeVisible();
});

it("opens the join steps from a community address", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByDisplayValue("https://relay.example"),
  ).toBeVisible();
});

it("asks for an invite link or community URL when the pasted value is neither", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "not a link",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByText("Paste an invite link or community URL."),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("presents an opened invite and clears it on close", async () => {
  const user = userEvent.setup();
  const { onInviteClose } = landing({
    invite: { community: "https://relay.example", code: "x", requestId: 7 },
  });
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(onInviteClose).toHaveBeenCalledWith(7);
});

it("offers creating a community where hosting is available", async () => {
  const user = userEvent.setup();
  const { onCreate } = landing({ hosted: true });
  await user.click(screen.getByRole("button", { name: "Create a community" }));
  expect(onCreate).toHaveBeenCalledOnce();
});
