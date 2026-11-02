// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { ChannelMemberAvatars } from "./ChannelMemberAvatars";

afterEach(cleanup);

it("keeps the people preview and overflow current as profiles and membership arrive", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let members = ["alice", "bob", "carol", "dana", "agent", "remote-agent"];
  let list = { channels: [{ id: "channel", members }] };
  let profiles = new Map<
    string,
    { name: string; picture?: string; isAgent?: boolean }
  >([
    ["alice", { name: "Alice" }],
    ["bob", { name: "Bob" }],
    ["carol", { name: "Carol" }],
    ["dana", { name: "Dana" }],
    ["remote-agent", { name: "Remote agent", isAgent: true }],
  ]);
  const choices = { identities: [{ pubkey: "agent" }] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  render(<ChannelMemberAvatars session={session} channelId="channel" />);
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    members,
    "background",
  );
  expect(screen.getByTitle("Alice")).toBeInTheDocument();
  expect(screen.getByTitle("Bob")).toBeInTheDocument();
  expect(screen.getByTitle("Carol")).toBeInTheDocument();
  expect(screen.queryByTitle("Dana")).not.toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();

  act(() => {
    profiles = new Map(profiles).set("dana", {
      name: "Dana",
      picture: "https://example.test/dana.png",
    });
    for (const listener of listeners) listener();
  });
  expect(screen.getByTitle("Dana").querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/dana.png",
  );
  expect(screen.queryByTitle("Carol")).not.toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();

  act(() => {
    members = ["bob"];
    list = { channels: [{ id: "channel", members }] };
    for (const listener of listeners) listener();
  });
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    ["bob"],
    "background",
  );
  expect(screen.getByTitle("Bob")).toBeInTheDocument();
  expect(screen.queryByTitle("Dana")).not.toBeInTheDocument();
  expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
});
