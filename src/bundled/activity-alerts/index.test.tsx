// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  type SidebarRow,
  sidebarRowMenuItems,
} from "../../features/channel-navigation/sidebar-rows-service";
import { profileTarget } from "../../features/profiles/target";
import { keypair } from "../../features/relay/testing";
import { channels, mount, people, storage, unmount } from "./testing";

afterEach(async () => {
  cleanup();
  await unmount();
});

async function open(watching: readonly string[] = []) {
  const h = await mount();
  for (const id of watching) h.watch(id);
  const card = h.cards
    .snapshot()
    .find((item) => item.key === "buzz.activity-alerts/activity-alerts");
  if (!card) throw new Error("No Activity alerts card");
  const Card = card.component;
  render(<Card active={() => true} />);
  return h;
}

it("turns all activity on and off from a Team channel's menu, and says Mute wins", async () => {
  let muted: string[] = [];
  const h = await mount({
    decode: async () => ({ sections: [], assignments: {}, starred: [], muted }),
  });
  const channel = h.owner.session.channels
    .list()
    .channels.find((item) => item.id === "room");
  if (!channel) throw new Error("No channel");
  const row = (kind: SidebarRow["kind"]): SidebarRow => ({
    id: "room",
    kind,
    label: "Room",
    sectionKey: "",
    channel,
    unread: h.owner.session.unread.snapshot({
      kind: "channel",
      channelId: "room",
    }),
  });
  const items = (kind: SidebarRow["kind"]) =>
    sidebarRowMenuItems(h.rows.snapshot(), row(kind));
  expect(items("dm")).toEqual([]);
  expect(items("team").map((item) => item.label)).toEqual([
    "Notify for all activity",
  ]);
  items("team")[0]?.onSelect();
  expect(channels.get(h.scope)).toEqual(["room"]);
  expect(items("team").map((item) => item.label)).toEqual([
    "Stop notifying for all activity",
  ]);
  items("team")[0]?.onSelect();
  expect(channels.get(h.scope)).toEqual([]);
  muted = ["room"];
  await h.owner.session.sidebarPreferences.refresh();
  expect(items("team").map((item) => item.label)).toEqual([
    "Notify for all activity when unmuted",
  ]);
});

it("searches, adds and removes people, and turns a channel off, in Settings", async () => {
  const user = userEvent.setup();
  const h = await open(["room"]);
  expect(screen.getByText("No one on your list")).toBeInTheDocument();
  const field = screen.getByLabelText("Add a person");
  await user.type(field, "nobody");
  expect(await screen.findByText("Searching…")).toBeInTheDocument();
  expect(
    await screen.findByText("No matching people.", undefined, {
      timeout: 3000,
    }),
  ).toBeInTheDocument();
  await user.clear(field);
  const someone = keypair().pubkey;
  await user.type(field, someone);
  await user.click(
    await screen.findByRole("button", { name: /^Add / }, { timeout: 3000 }),
  );
  expect(people.get(h.viewer.pubkey)).toEqual([someone]);
  await user.click(screen.getByRole("button", { name: /^Remove / }));
  expect(people.get(h.viewer.pubkey)).toEqual([]);
  await user.click(
    await screen.findByRole("button", {
      name: "Turn off all activity for #Room",
    }),
  );
  expect(channels.get(h.scope)).toEqual([]);
  expect(
    screen.getByText("No channels set to all activity"),
  ).toBeInTheDocument();
});

it("says so when a choice can't be saved", async () => {
  const user = userEvent.setup();
  const h = await open(["room"]);
  storage.full = true;
  const turnOff = await screen.findByRole("button", {
    name: "Turn off all activity for #Room",
  });
  await user.click(turnOff);
  // Beside the control that failed.
  expect(turnOff.closest(".buzz-preference-row")).toContainElement(
    screen.getByRole("alert"),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t save this choice on this device. Try again.",
  );
  expect(channels.get(h.scope)).toEqual(["room"]);
});

it("adds and removes a person from their profile, beside Profiles' own Info", async () => {
  const user = userEvent.setup();
  const h = await mount();
  h.install(true);
  await vi.waitFor(() =>
    expect(h.runtime.snapshot()["buzz.profiles"]?.status).toBe("active"),
  );
  const show = (pubkey: string) => {
    const target = profileTarget(pubkey) ?? "";
    const Panel = h.panels.resolve(target)?.component;
    if (!Panel) throw new Error("No profile panel");
    return render(<Panel target={target} close={() => {}} />);
  };
  const view = show(h.peer.pubkey);
  // Profiles keeps its own Info controls.
  expect(screen.getByRole("button", { name: "Copy npub" })).toBeInTheDocument();
  const toggle = screen.getByRole("switch", {
    name: "Notify me when they post",
  });
  await user.click(toggle);
  expect(people.get(h.viewer.pubkey)).toEqual([h.peer.pubkey]);
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(people.get(h.viewer.pubkey)).toEqual([]);
  view.unmount();
  // Not on the viewer's own profile.
  show(h.viewer.pubkey);
  expect(screen.getByRole("button", { name: "Copy npub" })).toBeInTheDocument();
  expect(screen.queryByRole("switch")).toBeNull();
  cleanup();
  // Without Profiles, the plugin claims no profile.
  h.install(false);
  await vi.waitFor(() =>
    expect(h.runtime.snapshot()["buzz.profiles"]).toBeUndefined(),
  );
  expect(h.panels.resolve(profileTarget(h.peer.pubkey) ?? "")).toBeUndefined();
});
