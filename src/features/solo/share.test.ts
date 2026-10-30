import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, profile, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { SOLO_NAMED_LABEL } from "./labels";
import {
  destinationShareAudience,
  grantSoloChatAccess,
  shareBlocker,
  shareChatsWithChannel,
} from "./share";

const chatId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    human = keypair(),
    bot = keypair(),
    late = keypair();
  const published: RelayEvent[] = [];
  const members = new Map([
    [chatId, [viewer.pubkey]],
    [channelId, [viewer.pubkey]],
  ]);
  let clock = 1_700_000_000;
  let failLink = false;
  let chosenName: string | undefined;
  let rejectGrant = false;
  let records: readonly import("../relay/outbox").OutgoingEvent[] = [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000 && rejectGrant)
      throw new PublishRejected("Invite denied");
    if (event.kind === 9 && failLink) throw new PublishRejected("Post denied");
    if (event.kind === 9000) {
      const id = event.tags.find(([tag]) => tag === "h")?.[1] ?? "";
      members.set(id, [
        ...new Set([
          ...(members.get(id) ?? []),
          event.tags.find(([tag]) => tag === "p")?.[1] ?? "",
        ]),
      ]);
    }
    published.push(event);
    clock++;
  });
  const query = vi.fn(
    async (filters: readonly import("../relay/events").ReadFilter[]) => {
      const events = [
        metadata(relay, chatId, chosenName ?? "Work", clock, [
          ["t", "stream"],
          ...(chosenName ? [["t", SOLO_NAMED_LABEL]] : []),
          ["private"],
          ["t", "buzz.solo"],
        ]),
        metadata(relay, channelId, "Planning", 1_700_000_000, [
          ["t", "stream"],
          ["private"],
        ]),
        ...[chatId, channelId].map((id) =>
          roster(relay, id, members.get(id) ?? [], clock),
        ),
        profile(human, { name: "Ari" }),
        ...published,
      ];
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
  );
  let knownAgent = false;
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      archiveAuthority: relay.pubkey,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: knownAgent ? [{ pubkey: bot.pubkey, name: "Agent" }] : [],
      }),
      media: () => undefined,
      query,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          await publish(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (value) => {
          records = structuredClone(value);
        },
      },
    },
  );
  owners.push(owner);
  return {
    session: owner.session,
    observe: (event: RelayEvent) =>
      owner.session.read([{ ids: [event.id], limit: 1 }]),
    viewer,
    human,
    bot,
    late,
    members,
    addDestination(key: string) {
      members.set(channelId, [
        ...new Set([...(members.get(channelId) ?? []), key]),
      ]);
      clock++;
    },
    publish,
    query,
    records: () => records,
    published,
    async chooseName(name: string) {
      chosenName = name;
      clock++;
      await owner.session.read(
        [
          {
            kinds: [39000],
            authors: [relay.pubkey],
            "#d": [chatId],
            limit: 1,
          },
        ],
        { fresh: true },
      );
    },
    failLink: (value: boolean) => {
      failLink = value;
    },
    setAgent: async () => {
      knownAgent = true;
      await owner.session.agentChoices.refresh();
    },
    async archive(key: string) {
      const archive = signed(relay, {
        kind: 13535,
        content: "",
        tags: [["-"], ["p", key]],
      });
      query.mockImplementationOnce(async () => [archive]);
      await owner.session.archives.refresh();
    },
    rejectGrant: (value: boolean) => {
      rejectGrant = value;
    },
    removeViewer: () => {
      members.set(chatId, []);
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().channels).toHaveLength(2),
      );
    },
  };
}

it("grants exact Solo chat membership to a person without touching the channel", async () => {
  const t = setup();
  await t.ready();
  const confirmed: string[] = [];
  await grantSoloChatAccess(
    t.session,
    chatId,
    [t.human.pubkey],
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
  );
  expect(confirmed).toEqual([t.human.pubkey]);
  expect(t.members.get(chatId)).toContain(t.human.pubkey);
  expect(t.members.get(channelId)).not.toContain(t.human.pubkey);
  expect(t.published.map((event) => event.kind)).toEqual([9000]);
  expect(t.published[0]?.tags).toContainEqual(["h", chatId]);
  expect(t.published[0]?.tags).toContainEqual(["p", t.human.pubkey]);
  expect(t.published[0]?.tags).toContainEqual(["role", "member"]);
});

it("Everyone snapshots the destination's signed roster including agents, freezes it for retry, and only grants access", async () => {
  const t = setup();
  await t.ready();
  await t.setAgent();
  t.addDestination(t.human.pubkey);
  t.addDestination(t.bot.pubkey);
  const frozen = await destinationShareAudience(
    t.session,
    channelId,
    new AbortController().signal,
  );
  expect(frozen).toEqual([t.bot.pubkey, t.human.pubkey].sort());
  t.addDestination(t.late.pubkey);
  const confirmed: string[] = [];
  await grantSoloChatAccess(
    t.session,
    chatId,
    frozen,
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
    true,
  );
  expect(confirmed).toEqual(frozen);
  expect(t.members.get(chatId)).toEqual(
    expect.arrayContaining([t.viewer.pubkey, t.human.pubkey, t.bot.pubkey]),
  );
  expect(t.members.get(chatId)).not.toContain(t.late.pubkey);
  expect(t.published).toHaveLength(2);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9000]);
  expect(
    t.published.find((event) =>
      event.tags.some(([name, key]) => name === "p" && key === t.bot.pubkey),
    )?.tags,
  ).toContainEqual(["role", "bot"]);
  expect(
    t.published.find((event) =>
      event.tags.some(([name, key]) => name === "p" && key === t.human.pubkey),
    )?.tags,
  ).toContainEqual(["role", "member"]);
  expect(
    t.published.every((event) =>
      event.tags.some(([name, id]) => name === "h" && id === chatId),
    ),
  ).toBe(true);
});

it("Everyone refuses missing fresh roster evidence instead of granting from the cached list", async () => {
  const t = setup();
  await t.ready();
  t.query.mockImplementationOnce(async () => []);
  await expect(
    destinationShareAudience(
      t.session,
      channelId,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/could not be confirmed/);
  expect(t.published).toHaveLength(0);
});

it.each([false, true])(
  "channel sharing skips archived members and still grants without cleaning the roster (archived after capture=%s)",
  async (afterCapture) => {
    const t = setup();
    await t.ready();
    t.addDestination(t.bot.pubkey);
    t.addDestination(t.human.pubkey);
    if (!afterCapture) await t.archive(t.bot.pubkey);
    const audience = await destinationShareAudience(
      t.session,
      channelId,
      new AbortController().signal,
    );
    if (afterCapture) await t.archive(t.bot.pubkey);
    else expect(audience).toEqual([t.human.pubkey]);
    const confirmed: string[] = [];
    await grantSoloChatAccess(
      t.session,
      chatId,
      audience,
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
      true,
      true,
      true,
    );
    expect(confirmed).toEqual([t.human.pubkey]);
    expect(t.members.get(chatId)).toContain(t.human.pubkey);
    expect(t.members.get(chatId)).not.toContain(t.bot.pubkey);
    expect(t.members.get(channelId)).toContain(t.bot.pubkey);
    expect(t.session.archives.state(t.bot.pubkey)).toBe("archived");
    expect(t.published.map((event) => event.kind)).toEqual([9000]);
  },
);

it("shares with a channel by granting only members missing from the chat, and posts nothing", async () => {
  const t = setup();
  await t.ready();
  t.addDestination(t.human.pubkey);
  t.addDestination(t.late.pubkey);
  t.members.set(chatId, [...(t.members.get(chatId) ?? []), t.late.pubkey]);
  const audience = await shareChatsWithChannel(t.session, [chatId], channelId, {
    signal: new AbortController().signal,
  });
  expect(audience).toEqual([t.human.pubkey, t.late.pubkey].sort());
  expect(t.members.get(chatId)).toContain(t.human.pubkey);
  // The member who already had access gets no second grant; no link is posted.
  expect(t.published.map((event) => event.kind)).toEqual([9000]);
  expect(t.published[0]?.tags).toContainEqual(["p", t.human.pubkey]);
});

it("retries a failed channel share without repeating confirmed grants", async () => {
  const t = setup();
  await t.ready();
  t.addDestination(t.human.pubkey);
  t.rejectGrant(true);
  const grants = new Map();
  await expect(
    shareChatsWithChannel(t.session, [chatId], channelId, {
      signal: new AbortController().signal,
      grants,
    }),
  ).rejects.toThrow();
  expect(t.published).toHaveLength(0);
  t.rejectGrant(false);
  await shareChatsWithChannel(t.session, [chatId], channelId, {
    signal: new AbortController().signal,
    grants,
  });
  await shareChatsWithChannel(t.session, [chatId], channelId, {
    signal: new AbortController().signal,
    grants,
  });
  expect(t.published.map((event) => event.kind)).toEqual([9000]);
});

it("refuses a known agent and won't share a chat the viewer lost access to", async () => {
  const t = setup();
  await t.ready();
  // Known agent classification is an admission rule, not a name-based distinction.
  await t.setAgent();
  await expect(
    grantSoloChatAccess(
      t.session,
      chatId,
      [t.bot.pubkey],
      new Map(),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/tagging them/);
  expect(t.published).toHaveLength(0);
  t.addDestination(t.human.pubkey);
  t.removeViewer();
  await expect(
    shareChatsWithChannel(t.session, [chatId], channelId, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/membership/);
  expect(t.published).toHaveLength(0);
});

it.each(["huddle", "metadataPending"] as const)(
  "rejects %s share destinations at the owner",
  async (flag) => {
    const t = setup();
    await t.ready();
    const list = t.session.channels.list();
    const session = {
      ...t.session,
      channels: {
        ...t.session.channels,
        refreshRoster: async () => true,
        list: () => ({
          ...list,
          channels: list.channels.map((c) =>
            c.id === channelId ? { ...c, [flag]: true } : c,
          ),
        }),
      },
    };
    await expect(
      destinationShareAudience(
        session,
        channelId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Destination membership");
  },
);

it("blocks a share the viewer can't make, or one over 100 people", async () => {
  const t = setup();
  await t.ready();
  const chat = t.session.channels
    .list()
    .channels.find((item) => item.id === chatId);
  if (!chat) throw new Error("Missing chat");
  expect(shareBlocker(t.session, [chat], [t.human.pubkey])).toBeUndefined();
  expect(
    shareBlocker(t.session, [{ ...chat, members: [] }], [t.human.pubkey]),
  ).toMatch(/can’t share access/);
  const crowd = Array.from({ length: 101 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  expect(shareBlocker(t.session, [chat], crowd)).toMatch(/too many members/);
});
