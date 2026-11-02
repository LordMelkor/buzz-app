// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { verifyEvent, type EventTemplate } from "nostr-tools";
import { nativeIdentityEnabled } from "../../features/identity/service";
import type { Role } from "../../features/communities/roster";
import type { RelayEvent } from "../../features/relay/events";
import { keypair, signed, type Key } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import { CommunityAdmin } from "./CommunityAdmin";
import { apply } from "./index";
import { createCommunityMembership } from "./membership";

const { relayKey } = vi.hoisted(() => ({ relayKey: "f".repeat(64) }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const ownerKey = keypair();
const adminKey = keypair();
const owner = ownerKey.pubkey;
const admin = adminKey.pubkey;
const member = "2".repeat(64);
const added = "3".repeat(64);
const INITIAL: [string, Role][] = [
  [owner, "owner"],
  [admin, "admin"],
  [member, "member"],
];
/** The relay's persisted roster: accepted commands change it, reads see it. */
let roster = new Map(INITIAL);
const snapshot = () => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [
    ["-"],
    ...[...roster].map(([pubkey, role]) => ["member", pubkey, role]),
  ],
});

type Answer = { status?: number; body?: unknown } | Error;
/** Host stand-in: signs with the viewer's key and applies accepted commands. */
function host(viewer: Key, answer: (event: RelayEvent) => Answer | undefined) {
  const published: RelayEvent[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_sign")
      return signed(viewer, (args as { event: EventTemplate }).event);
    expect(command).toBe("relay_http");
    const { community, path, method, body } = args as {
      community: string;
      path: string;
      method: string;
      body: string;
    };
    expect({ community, path, method }).toEqual({
      community: "https://primary.example",
      path: "/events",
      method: "POST",
    });
    const event = JSON.parse(body) as RelayEvent;
    expect(verifyEvent(event)).toBe(true);
    published.push(event);
    const result = answer(event) ?? {
      body: { event_id: event.id, accepted: true, message: "" },
    };
    if (result instanceof Error) throw result;
    if ((result.status ?? 200) === 200) {
      const target = event.tags[0]?.[1] as string;
      const role = event.tags[1]?.[1] as Role | undefined;
      if (event.kind === 9031) roster.delete(target);
      else roster.set(target, role as Role);
    }
    return {
      status: result.status ?? 200,
      headers: {},
      body: JSON.stringify(result.body),
    };
  });
  return published;
}

const NAMES = new Map([
  [owner, "Olive"],
  [admin, "Ada"],
  [member, "Mo"],
  [added, "Nia"],
]);
/** The visible role line of one roster row, or null once it is gone. */
function shownRole(pubkey: string) {
  const name = NAMES.get(pubkey) as string;
  const row = within(screen.getByRole("list", { name: "Members" }))
    .queryAllByRole("listitem")
    // Labels are `Name · key`: every target carries a key qualifier.
    .find((item) => within(item).queryByText(new RegExp(`^${name} · `)));
  return row ? (row.querySelectorAll("p")[1]?.textContent ?? "") : null;
}
const actions = (pubkey: string) =>
  screen.queryByRole("button", {
    name: new RegExp(`^Actions for ${NAMES.get(pubkey)} · `),
  });

function relay(viewer: string) {
  const read = vi.fn(async () => [snapshot()]);
  const profiles = new Map(
    [...NAMES].map(([pubkey, name]) => [pubkey, { name }]),
  );
  const session = {
    relayAuthor: relayKey,
    read,
    viewer,
    media: () => undefined,
    directMessages: { people: async () => ({ people: [], hasMore: false }) },
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

beforeEach(() => {
  roster = new Map(INITIAL);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  // Native builds ship no broker; any fetch would be a routing mistake.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected broker request");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockClear();
});

it("keeps the Membership card registered in a native build", () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const settingsCards = { register: vi.fn() };
  const data = relay(owner).relay;
  const membership = createCommunityMembership(data);
  apply({
    relay: data,
    adminAccess: { membership },
    settingsCards,
    effect: vi.fn(),
  } as unknown as Parameters<typeof apply>[0]);
  expect(settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "membership",
      title: "Membership",
      section: "administration",
      component: expect.any(Function),
    }),
  );
  membership.dispose();
});

it("lets a native owner add, promote, demote and remove through the host signer", async () => {
  const user = userEvent.setup();
  const published = host(ownerKey, () => undefined);
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByRole("list", { name: "Members" });
  // The owner row and the viewer's own row carry no actions.
  expect(actions(owner)).toBeNull();
  expect(actions(admin)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Invite members" }));
  // Invite minting is not part of this host stand-in; only the add is exercised.
  const dialog = await screen.findByRole("dialog", {
    name: "Add or invite people",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Public identity" }),
    added,
  );
  await user.click(within(dialog).getByRole("button", { name: "Add member" }));
  expect(
    await within(dialog).findByText("Member added directly."),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(shownRole(added)).toBe("Member"));

  const change = async (pubkey: string, item: string) => {
    await user.click(actions(pubkey) as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: item }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: item,
      }),
    );
    expect(
      await screen.findByText("Change accepted by the relay."),
    ).toBeVisible();
  };
  await change(member, "Make admin");
  await waitFor(() => expect(shownRole(member)).toBe("Admin"));
  await change(admin, "Make member");
  await waitFor(() => expect(shownRole(admin)).toBe("Member"));
  await change(added, "Remove");
  await waitFor(() => expect(shownRole(added)).toBeNull());

  // Each write is one owner-signed NIP-43 command, followed by a roster re-read.
  expect(
    published.map(({ kind, pubkey, content, tags }) => ({
      kind,
      pubkey,
      content,
      tags,
    })),
  ).toEqual([
    {
      kind: 9030,
      pubkey: owner,
      content: "",
      tags: [
        ["p", added],
        ["role", "member"],
      ],
    },
    {
      kind: 9032,
      pubkey: owner,
      content: "",
      tags: [
        ["p", member],
        ["role", "admin"],
      ],
    },
    {
      kind: 9032,
      pubkey: owner,
      content: "",
      tags: [
        ["p", admin],
        ["role", "member"],
      ],
    },
    { kind: 9031, pubkey: owner, content: "", tags: [["p", added]] },
  ]);
  expect(read).toHaveBeenCalledTimes(5);
  expect(fetch).not.toHaveBeenCalled();
});

it("offers a native admin only member removal and surfaces the relay's refusal", async () => {
  const user = userEvent.setup();
  const refusal =
    "invalid: actor not authorized: admins can only remove members";
  const published = host(adminKey, () => ({
    status: 403,
    body: { error: refusal },
  }));
  const { relay: data } = relay(admin);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByRole("list", { name: "Members" });
  // Protected rows: the owner and the admin's own row are untouchable.
  expect(actions(owner)).toBeNull();
  expect(actions(admin)).toBeNull();
  await user.click(actions(member) as HTMLElement);
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["Remove"]);
  await user.click(screen.getByRole("menuitem", { name: "Remove" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  // Authority is the relay's: its exact refusal shows and nothing changes.
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(refusal),
  );
  expect(shownRole(member)).toBe("Member");
  expect(published.map((event) => event.kind)).toEqual([9031]);

  // An admin adds only plain members: no role choice is offered.
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Invite members" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Add or invite people",
  });
  expect(
    within(dialog).queryByRole("button", { name: "Choose member role" }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

// `applied` is whether the fake relay persisted the command despite the error.
it.each([
  [
    "a host transport failure",
    new Error("Relay unreachable"),
    "Relay unreachable",
    false,
  ],
  [
    "an unlisted relay refusal",
    { status: 500, body: { error: "database: connection reset" } },
    "Community request failed (500)",
    false,
  ],
  [
    // The relay applied it, but the receipt names another event.
    "an unconfirmed receipt",
    { body: { event_id: "0".repeat(64), accepted: true } },
    "Member change could not be confirmed",
    true,
  ],
])(
  "recovers from %s and refreshes to the relay's roster",
  async (_, failure, shown, applied) => {
    const user = userEvent.setup();
    let fail = true;
    const published = host(ownerKey, () => (fail ? failure : undefined));
    const { relay: data, read } = relay(owner);
    render(<CommunityAdmin relay={data} active={() => true} />);
    await screen.findByRole("list", { name: "Members" });
    const promote = async () => {
      await user.click(actions(member) as HTMLElement);
      await user.click(
        await screen.findByRole("menuitem", { name: "Make admin" }),
      );
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Make admin",
        }),
      );
    };
    await promote();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(shown),
    );
    // An unconfirmed write claims nothing: the list is not re-read or changed.
    expect(read).toHaveBeenCalledOnce();
    expect(shownRole(member)).toBe("Member");
    expect(roster.get(member)).toBe(applied ? "admin" : "member");
    fail = false;
    await user.keyboard("{Escape}");
    // Refresh shows whatever the relay actually holds.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(shownRole(member)).toBe(applied ? "Admin" : "Member"),
    );
    if (!applied) {
      // The controls stay usable; a retry goes through.
      await promote();
      await waitFor(() => expect(shownRole(member)).toBe("Admin"));
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(published).toHaveLength(applied ? 1 : 2);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("still mints invite links natively", async () => {
  const user = userEvent.setup();
  const url = "https://primary.example/invite/native";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("relay_http");
    expect(args).toEqual({
      community: "https://primary.example",
      path: "/api/invites",
      method: "POST",
      body: JSON.stringify({ ttl_secs: 3 * 24 * 60 * 60, max_uses: null }),
    });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ code: "native", url }),
    };
  });
  render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
  await user.click(
    await screen.findByRole("button", { name: "Invite members" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Add or invite people",
  });
  expect(await within(dialog).findByDisplayValue(url)).toBeVisible();
  expect(invoke).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
