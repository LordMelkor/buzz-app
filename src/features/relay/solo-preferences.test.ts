import { createSoloPreferences } from "./solo-preferences";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  kitRecordFits,
  parseKitRecord,
  type Groups,
  type KitRecord,
} from "../channel-templates/model";
import { matchesEvent } from "./projection";
import { flush, keypair, roster, scriptedTransport, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

afterEach(() => vi.restoreAllMocks());

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://primary.example";
const groups: Groups = {
  type: "groups",
  id: "me",
  groups: [{ id: "work", name: "Solo work", defaultTemplateId: "template" }],
  assignments: { [other]: "work" },
};
function fixture() {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  let legacy: SidebarPreferences = {
    sections: [{ id: "work", name: "OG work", icon: "★", order: 0 }],
    assignments: { [channel]: "work" },
    starred: [],
    muted: [],
  };
  const install = (value: Groups, deleted = false) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    events.push(
      signed(viewer, {
        kind: 30078,
        created_at: time++,
        tags: [
          ["d", coordinate(record)],
          ["t", kitTag(record)],
        ],
        content: JSON.stringify(record),
      }),
    );
  };
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const assignment = vi.fn(async (intent) => {
    const assignments = { ...legacy.assignments };
    if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
    else delete assignments[intent.channelId];
    legacy = { ...legacy, assignments };
    return legacy;
  });
  const removal = vi.fn(async (sectionId: string) => {
    legacy = {
      ...legacy,
      sections: legacy.sections.filter(({ id }) => id !== sectionId),
      assignments: Object.fromEntries(
        Object.entries(legacy.assignments).filter(([, id]) => id !== sectionId),
      ),
    };
    return legacy;
  });
  const star = vi.fn(async ({ channelId, starred }) => {
    legacy = { ...legacy, starred: starred ? [channelId] : [] };
    return legacy.starred;
  });
  const sort = vi.fn(async () => ({}));
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: () => undefined,
      query,
      decodeSidebarPreferences: async () => legacy,
      writeSidebarAssignment: assignment,
      removeSidebarSection: removal,
      writeSidebarStar: star,
      writeSidebarSort: sort,
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare,
      },
      writer: {
        kinds: [30078],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return {
    ...owner,
    query,
    assignment,
    removal,
    sort,
    star,
    publish,
    prepare,
    install,
    events,
    preferences: owner.session.sidebarPreferences,
  };
}

it("retries a catalog read cancelled by initial roster authority", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelKit: { decode: async () => [], prepare: async () => "" },
  });
  try {
    const catalog = owner.session.channelKit.refresh();
    await flush();
    const interrupted = wire.next();
    expect(interrupted.filters[0]?.["#t"]).toEqual([
      KIT_TAG,
      TEAM_MANIFEST_TAG,
      ME_KIT_TAG,
    ]);
    owner.session.channels.ensureList();
    await flush();
    wire.next().respond([roster(relay, channel, [viewer.pubkey])]);
    await flush();
    expect(interrupted.signal?.aborted).toBe(true);
    const retry = wire.pending.find((entry) => entry.filters[0]?.["#t"]);
    expect(retry?.filters).toEqual(interrupted.filters);
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await catalog;
    expect(owner.session.channelKit.snapshot().status).toBe("ready");
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "does not retry a catalog read cancelled by %s",
  async (action) => {
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      channelKit: { decode: async () => [], prepare: async () => "" },
    });
    try {
      const catalog = owner.session.channelKit.refresh();
      await flush();
      const interrupted = wire.next();
      owner[action]();
      await catalog;
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
    } finally {
      owner.dispose();
    }
  },
);

it("starts Solo preferences empty and changes only the distinct Solo catalog coordinate", async () => {
  const f = fixture();
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await solo.queries.ensure();
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    await solo.queries.createAndAssign(channel, {
      id: "work",
      name: "Solo work",
    });
    expect(solo.queries.snapshot().data?.assignments).toEqual({
      [channel]: "work",
    });
    expect(solo.queries.starWritable).toBe(false);
    const writes = f.publish.mock.calls.map(([event]) => event);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tags).toContainEqual(["t", ME_KIT_TAG]);
    expect(
      writes[0] &&
        matchesEvent(writes[0], {
          "#t": [KIT_TAG, TEAM_MANIFEST_TAG],
          limit: 500,
        }),
    ).toBe(false);
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    await solo.queries.removeSection("work");
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    expect(f.star).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("retains Solo tombstone revision and never creates over an unread catalog", async () => {
  const f = fixture();
  f.install({ type: "groups", id: "me", groups: [], assignments: {} }, true);
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await expect(
      solo.queries.createAndAssign(channel, { id: "new", name: "New" }),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await solo.queries.ensure();
    await solo.queries.createAndAssign(channel, { id: "new", name: "New" });
    expect(solo.queries.snapshot().data?.sections[0]?.name).toBe("New");
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("invalidates the session-owned Solo projection on refreshed heads, including tombstones", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Solo work", defaultTemplateId: "" }],
    assignments: { [channel]: "work" },
  };
  try {
    await solo.ensure();
    await f.preferences.ensure();
    expect(solo.snapshot().data?.sections).toEqual([]);
    f.install(value);
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Solo work"),
    );
    f.install({
      ...value,
      groups: [
        { id: "work", defaultTemplateId: "", name: "Renamed elsewhere" },
      ],
    });
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Renamed elsewhere"),
    );
    f.install(value, true);
    await f.session.channelKit.refresh();
    await vi.waitFor(() => {
      expect(solo.snapshot().data?.sections).toEqual([]);
      expect(solo.snapshot().data?.assignments).toEqual({});
    });
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("drops the retired Solo channel list on the next project write", async () => {
  const f = fixture();
  try {
    f.install({ ...groups, channels: [channel, other] } as Groups);
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    const value = JSON.parse(
      f.publish.mock.calls.at(-1)?.[0].content ?? "null",
    ).value;
    expect(value.channels).toBeUndefined();
    expect(value.assignments).toEqual({ [channel]: "work", [other]: "work" });
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("does not overwrite project filing when a refresh fails, and reconciles retries against the fresh head", async () => {
  const f = fixture();
  try {
    f.install(groups);
    await f.session.soloPreferences.ensure();
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.session.soloPreferences.assign(channel, "work"),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    const count = f.publish.mock.calls.length;
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.publish).toHaveBeenCalledTimes(count);
  } finally {
    f.dispose();
  }
});

it("confirms native-shaped reordered assignment maps without losing group order", async () => {
  const f = fixture();
  try {
    f.install(groups);
    f.prepare.mockImplementation(async (record) =>
      JSON.stringify(record, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("checks the exact project capacity before saving and reclaims a removed filing", async () => {
  const f = fixture();
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
    assignments: {},
  };
  const record = () => ({
    version: 1 as const,
    community,
    deleted: false,
    value,
  });
  let id = "";
  for (let i = 1; i < 1000; i++) {
    id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    value.assignments[id] = "work";
    if (!kitRecordFits(record())) {
      delete value.assignments[id];
      break;
    }
  }
  parseKitRecord(record(), community);
  f.install(value);
  try {
    await f.session.soloPreferences.ensure();
    await expect(f.session.soloPreferences.assign(id, "work")).rejects.toThrow(
      "Solo workspace storage is full",
    );
    expect(f.publish).not.toHaveBeenCalled();
    const removed = Object.keys(value.assignments)[0];
    if (!removed) throw new Error("Missing filing");
    await f.session.soloPreferences.assign(removed, undefined);
    await f.session.soloPreferences.assign(id, "work");
    const assignments = f.session.soloPreferences.snapshot().data?.assignments;
    expect(assignments?.[id]).toBe("work");
    expect(assignments?.[removed]).toBeUndefined();
  } finally {
    f.dispose();
  }
});
