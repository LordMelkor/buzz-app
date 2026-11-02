// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { SOLO_LABEL } from "../../features/solo/labels";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  profile,
  signed,
} from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import { ChatSharedMark, soloSharedMarkId } from "./ChatSharedMark";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";

/** The Solo header entry point: the people icon opens the shared access dialog. */
function SoloShare({
  session,
  channel,
  signal,
  onClose,
}: {
  session: RelaySession;
  channel: { id: string };
  signal?: AbortSignal;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Access
      </button>
      <ChatSharedMark
        session={session}
        channel={list.channels.find((item) => item.id === channel.id)}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ChannelMembersDialog
          session={session}
          channelId={channel.id}
          signal={signal}
          trigger={trigger}
          close={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
// The share result is a host toast; the shared Toast owns how it shows.
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", async (original) => ({
  ...(await original<typeof import("../../shared/design-system/ui/Toast")>()),
  useToastNotification: () => notify,
}));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  notify.mockReset();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
function fixture(direct = false) {
  const viewer = keypair(),
    relay = keypair(),
    aria = keypair(),
    dev = keypair();
  const profiles = [
    profile(aria, { name: "Aria" }),
    profile(dev, { name: "Dev" }),
  ];
  let clock = 1_700_000_000;
  const members = new Map([
    [source, [viewer.pubkey]],
    [destination, [viewer.pubkey]],
  ]);
  const metadataEvents = new Map([
    [
      source,
      metadata(relay, source, "Work", clock, [
        ["t", "stream"],
        ["t", SOLO_LABEL],
        ["private"],
        // The owner's own Solo chat, or one shared with them as a guest.
        ["P", direct ? viewer.pubkey : relay.pubkey],
      ]),
    ],
    [
      destination,
      metadata(relay, destination, "Planning", clock, [
        ["t", "stream"],
        ["private"],
      ]),
    ],
  ]);
  const published: RelayEvent[] = [];
  let failLink = false;
  let holdLink: Promise<void> | undefined;
  let failGrant = false;
  let failDetails = false;
  let failRoster = false;
  let holdRoster: Promise<void> | undefined;
  let loseDetailsResponse = false;
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [source]: "g" });
  const unfiledProjects = projects({});
  let filed = direct;
  const placement = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  let records: readonly import("../../features/relay/outbox").OutgoingEvent[] =
    [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9) await holdLink;
    if (event.kind === 9 && failLink) throw new PublishRejected("Post refused");
    if (event.kind === 9000 && failGrant)
      throw new PublishRejected("Chat invite refused");
    if (event.kind === 9002 && failDetails)
      throw new PublishRejected("Settings refused");
    published.push(event);
    if (event.kind === 9002) {
      const value = (tag: string) =>
        event.tags.find(([name]) => name === tag)?.[1];
      const previous = metadataEvents.get(source)?.tags ?? [];
      const ttl = value("ttl") ?? previous.find(([tag]) => tag === "ttl")?.[1];
      const visibility = value("visibility");
      const written = event.tags.flatMap(([tag, label]) =>
        tag === "t" ? [label ?? ""] : [],
      );
      const labels = written.length
        ? written.filter(Boolean)
        : previous.flatMap(([tag, label]) =>
            tag === "t" && label !== "stream" ? [label ?? ""] : [],
          );
      metadataEvents.set(
        source,
        metadata(relay, source, value("name") ?? "Work", ++clock, [
          ["t", "stream"],
          ...labels.map((label) => ["t", label]),
          ...previous.filter(([tag]) => tag === "P"),
          [
            visibility
              ? visibility === "open"
                ? "public"
                : "private"
              : previous.some(([tag]) => tag === "public")
                ? "public"
                : "private",
          ],
          [
            "about",
            value("about") ??
              previous.find(([tag]) => tag === "about")?.[1] ??
              "",
          ],
          ...(ttl && ttl !== "0" ? [["ttl", ttl]] : []),
        ]),
      );
      if (loseDetailsResponse) throw new Error("Lost settings response");
    }
    if (event.kind === 9000) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(id, [...new Set([...(members.get(id) ?? []), key])]);
      clock++;
    }
    if (event.kind === 9001) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(
        id,
        (members.get(id) ?? []).filter((member) => member !== key),
      );
      clock++;
    }
  });
  const detailsSign = vi.fn(
    async (event: import("nostr-tools").EventTemplate) => signed(viewer, event),
  );
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      media: () => undefined,
      query: async (filters) => {
        if (
          filters.some(
            (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 39002,
          )
        ) {
          await holdRoster;
          if (failRoster) throw new Error("Roster unavailable");
        }
        if (filters.some((filter) => filter.search))
          return profiles.filter((item) =>
            item.content
              .toLowerCase()
              .includes(filters[0]?.search?.toLowerCase() ?? ""),
          );
        const events = [
          ...metadataEvents.values(),
          ...[...members.keys()].map((id) =>
            signed(relay, {
              kind: 39001,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ["p", viewer.pubkey, "owner"],
              ],
            }),
          ),
          ...[...members].map(([id, keys]) =>
            signed(relay, {
              kind: 39002,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ...keys.map((key) => [
                  "p",
                  key,
                  "",
                  key === viewer.pubkey
                    ? "owner"
                    : profiles.some(
                          (event) =>
                            event.pubkey === key &&
                            JSON.parse(event.content).is_agent,
                        )
                      ? "bot"
                      : "member",
                ]),
              ],
            }),
          ),
          ...published,
          ...profiles,
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: {
        sign: detailsSign,
        publish,
      },
      memberAdministration: {
        sign: async (event) => signed(viewer, event),
        publish,
      },
      writer: {
        kinds: [9, 9000, 9002],
        sign: async (event) => signed(viewer, event),
        publish: async (event) => {
          await publish(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  owners.push(owner);
  const session = direct
    ? {
        ...owner.session,
        soloPreferences: {
          ...owner.session.soloPreferences,
          snapshot: () => (filed ? filedProjects : unfiledProjects),
          refresh: async () => {},
          assign: placement,
        },
      }
    : owner.session;
  const channel = () =>
    owner.session.channels.list().channels.find((item) => item.id === source);
  return {
    session,
    placement,
    failDetails(value: boolean) {
      failDetails = value;
    },
    loseDetailsResponse(value: boolean) {
      loseDetailsResponse = value;
    },
    failRoster(value: boolean) {
      failRoster = value;
    },
    holdRoster(value: Promise<void> | undefined) {
      holdRoster = value;
    },
    addProfile(key: ReturnType<typeof keypair>, name: string, agent = false) {
      profiles.push(
        profile(key, { name, ...(agent ? { is_agent: true } : {}) }),
      );
    },
    viewer,
    aria,
    dev,
    members,
    setArchived(archived: boolean) {
      metadataEvents.set(
        source,
        metadata(relay, source, "Work", ++clock, [
          ["t", "stream"],
          ["t", SOLO_LABEL],
          ["private"],
          ["P", direct ? viewer.pubkey : relay.pubkey],
          ["archived", String(archived)],
        ]),
      );
      session.channels.refreshList?.();
    },
    published,
    publish,
    detailsSign,
    channel,
    failLink(value: boolean) {
      failLink = value;
    },
    holdLink(value: Promise<void> | undefined) {
      holdLink = value;
    },
    failGrant(value: boolean) {
      failGrant = value;
    },
    setSourceMembers(keys: string[]) {
      members.set(source, keys);
      clock++;
    },
    setDestinationMembers(keys: string[]) {
      members.set(destination, keys);
      clock++;
    },
    addDestination(key: string) {
      members.set(destination, [
        ...new Set([...(members.get(destination) ?? []), key]),
      ]);
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await waitFor(() => expect(channel()?.channelType).toBe("solo"), {
        interval: 1,
      });
    },
    mount(props: { signal?: AbortSignal; onClose?: () => void } = {}) {
      const initial = channel();
      if (!initial) throw new Error("Chat not loaded");
      return render(
        <SoloShare session={session} channel={initial} {...props} />,
      );
    },
  };
}

const search = (dialog: HTMLElement) =>
  within(dialog).getByRole("searchbox", { name: "Search people and channels" });
async function chooseDestination(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.clear(search(dialog));
  await user.type(search(dialog), "Plan");
  await user.click(
    await within(dialog).findByRole("button", { name: "Select Planning" }),
  );
}
const waitForAccess = (dialog: HTMLElement) =>
  waitFor(() =>
    expect(
      within(dialog).queryByRole("status", { name: "Loading members" }),
    ).toBeNull(),
  );

it("adds a person at once under the chat's share rule, by Add or Enter", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Aria");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByRole("button", { name: /^Add Aria/ });
  expect(results).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", t.aria.pubkey]);
  expect(await within(dialog).findByText("Aria is in the chat.")).toBeVisible();
  await user.clear(search(dialog));
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Dev");
  await user.click(
    await within(dialog).findByRole("button", { name: /^Add Dev/ }),
  );
  await waitFor(() => expect(t.members.get(source)).toContain(t.dev.pubkey));
  // People are added; nothing waits for a footer Share.
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
});

it("Copy alone neither saves selections nor grants access", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(clipboard).toHaveBeenCalledWith(`buzz://channel/${source}`);
  const copied = within(dialog).getByRole("button", { name: "Link copied" });
  expect(copied).toHaveFocus();
  expect(within(dialog).getAllByText("Link copied")).toHaveLength(1);
  clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await user.click(copied);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the link.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(
    within(dialog).getByRole("button", { name: "Link copied" }),
  ).toHaveFocus();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Access" }));
  expect(
    search(screen.getByRole("dialog", { name: "Share access" })),
  ).toHaveValue("");
  expect(
    within(screen.getByRole("dialog", { name: "Share access" })).getByRole(
      "button",
      { name: "Copy link" },
    ),
  ).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("shares to a channel by giving its current members access, then posts one link; Retry adds whoever is still missing", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failGrant(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await chooseDestination(user, dialog);
  expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Chat invite refused",
  );
  expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
  expect(t.published).toHaveLength(0);
  // Retry reads the channel again, so a member who joined meanwhile is included.
  t.addDestination(t.dev.pubkey);
  t.failGrant(false);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(t.members.get(source)).toContain(t.dev.pubkey);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9000, 9]),
  );
});

it("Done never promotes or removes a Solo chat, and conversion stays in the chat menu", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(within(dialog).queryByRole("switch")).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Convert to channel" }),
  ).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.placement).not.toHaveBeenCalled();
  expect(t.channel()?.channelType).toBe("solo");
});

it("leaves agents to mentions but includes channel bots without waking them", async () => {
  const t = fixture();
  await t.ready();
  const bot = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.addDestination(bot.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Helper");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByText("To add an agent, mention it in the chat.");
  expect(results).toHaveTextContent("No other matching people.");
  expect(within(results).queryByRole("button", { name: /Helper/ })).toBeNull();
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  // Planning is private, so the toast names it without a hash like the sidebar.
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Shared in Planning",
    "success",
    undefined,
  );
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(t.published[0]?.tags).toContainEqual(["role", "bot"]);
  expect(t.published[1]?.tags.some(([name]) => name === "p")).toBe(false);
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
});

it("shows loading and failed current access with refresh, never an empty roster", async () => {
  const t = fixture();
  await t.ready();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  t.failRoster(true);
  const user = userEvent.setup();
  t.mount();
  try {
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    const access = within(dialog).getByRole("region", { name: "Member list" });
    expect(
      within(access).getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    release();
    expect(await within(access).findByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    // A failed roster read never presents verified roles.
    expect(within(access).queryByText("Owner", { exact: true })).toBeNull();
    t.failRoster(false);
    t.holdRoster(undefined);
    const refresh = within(dialog).getByRole("button", {
      name: "Retry member data",
    });
    await waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(refresh);
    await within(access).findByRole("region", { name: "People" });
    expect(within(access).queryByRole("alert")).toBeNull();
    t.failRoster(true);
    await chooseDestination(user, dialog);
    const selectedChannel = within(dialog).getByRole("region", {
      name: "Selected channel",
    });
    const unavailable = await within(selectedChannel).findByRole("button", {
      name: /^Planning.*Participants unavailable/,
    });
    expect(selectedChannel).not.toHaveTextContent("0 members");
    await user.click(unavailable);
    expect(within(selectedChannel).getByRole("status")).toHaveTextContent(
      "unavailable",
    );
    t.failRoster(false);
    await user.click(
      within(selectedChannel).getByRole("button", {
        name: "Retry participants",
      }),
    );
    await within(selectedChannel).findByRole("button", {
      name: /^Planning.*1 member/,
    });
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    release();
    t.holdRoster(undefined);
  }
});

it("groups agents and people by role while only verified additional humans mark the chat Shared", async () => {
  const t = fixture();
  const bot = keypair(),
    unknown = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.members.set(source, [t.viewer.pubkey, bot.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  let dialog = screen.getByRole("dialog", { name: "Share access" });
  const agents = await within(dialog).findByRole("region", { name: "Agents" });
  await within(agents).findByText("Helper Bot");
  expect(within(agents).getByRole("heading")).toHaveTextContent("Agents · 1");
  const people = within(dialog).getByRole("region", { name: "People" });
  expect(people).toHaveTextContent("(you)");
  expect(people).not.toHaveTextContent("Helper Bot");

  t.setSourceMembers([t.viewer.pubkey, bot.pubkey, unknown.pubkey]);
  await act(async () => {
    await t.session.channels.refreshRoster?.(source, { consistency: "strong" });
  });
  await waitFor(() =>
    expect(
      within(
        within(dialog).getByRole("region", { name: "People" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
  expect(within(dialog).getAllByText("Helper Bot")).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
  t.addProfile(unknown, "Guest Human");
  await t.session.profiles.ensure([unknown.pubkey], "foreground");
  await waitFor(() =>
    expect(document.querySelector("[data-solo-shared]")).not.toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "Access" }));
  dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Guest Human");
  expect(t.publish).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole("button", { name: "Done" }));
});

it("shows Shared on cold render from verified members and cached human evidence without administration demand", async () => {
  const t = fixture();
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  await t.session.profiles.ensure([t.aria.pubkey], "foreground");
  const channel = t.channel();
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
  expect(channel?.cached).not.toBe(true);
  // The sidebar's mark describes the row and opens its access list.
  const onOpen = vi.fn();
  render(
    <>
      <button type="button" aria-describedby={soloSharedMarkId(source)}>
        Row
      </button>
      <ChatSharedMark session={t.session} channel={channel} onOpen={onOpen} />
    </>,
  );
  expect(
    screen.getByRole("button", { name: "Row" }),
  ).toHaveAccessibleDescription("Shared");
  await userEvent.click(screen.getByRole("button", { name: "Shared" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
});

it("offers matching people and channels as labelled results without public keys", async () => {
  const t = fixture();
  const planningPerson = keypair();
  t.addProfile(planningPerson, "Planning Person");
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Planning");
  const people = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(people).findByRole("button", { name: /^Add Planning Person/ });
  const channels = within(dialog).getByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("button", { name: "Select Planning" }),
  ).toHaveTextContent("Select");
  expect(dialog).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  expect(dialog).not.toHaveTextContent(
    formatPublicKey(planningPerson.pubkey) ?? "",
  );
  await user.click(
    within(channels).getByRole("button", { name: "Select Planning" }),
  );
  expect(search(dialog)).toHaveValue("");
  expect(
    within(dialog).getByRole("region", { name: "Selected channel" }),
  ).toHaveTextContent("Planning");
  expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove Planning" }),
  );
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("distinguishes namesakes in results and adds only the chosen identity", async () => {
  const t = fixture();
  const first = keypair(),
    second = keypair();
  t.addProfile(first, "Morgan");
  t.addProfile(second, "Morgan");
  await t.ready();
  const labels = publicKeyLabels([first.pubkey, second.pubkey]);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Morgan");
  const firstAdd = await within(dialog).findByRole("button", {
    name: `Add Morgan (${labels.get(first.pubkey)})`,
  });
  expect(
    within(dialog).getByRole("button", {
      name: `Add Morgan (${labels.get(second.pubkey)})`,
    }),
  ).toBeVisible();
  // Without a naming plugin the rows still differ visibly, by key only.
  const shown = within(dialog)
    .getAllByText(/^npub…/)
    .map((node) => node.textContent);
  expect(shown).toHaveLength(2);
  expect(new Set(shown).size).toBe(2);
  expect(shown).toContain(
    firstAdd.getAttribute("aria-label")?.match(/\((npub…\w+)\)/)?.[1],
  );
  await user.click(firstAdd);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", first.pubkey]);
  expect(t.published[0]?.tags).not.toContainEqual(["p", second.pubkey]);
});

it("lets the chat owner remove someone with access from the row menu", async () => {
  const t = fixture(true);
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  const people = await within(dialog).findByRole("region", { name: "People" });
  await user.click(
    await within(people).findByRole("button", { name: "Actions for Aria" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove from chat" }),
  );
  const confirm = await within(dialog).findByRole("button", {
    name: "Remove member",
  });
  expect(dialog).toHaveAccessibleName("Remove member from chat");
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9001]),
  );
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
});
