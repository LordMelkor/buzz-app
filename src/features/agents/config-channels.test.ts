import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import type { EventTemplate } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { createMemberAdministration } from "../channel-members/administration";
import { PublishRejected } from "../relay/outbox";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import type { RelaySession } from "../relay/session";
import { ARTIFACT_MAX_EVENT_BYTES, uuidv5 } from "./agent-config-artifacts";
import {
  BUZZ_TEAM_IMPORT_NS,
  configSupport,
  createConfigChannels,
  importedTeamId,
  teamSubject,
} from "./config-channels";

const owner = "a".repeat(64);
const agent = "b".repeat(64);
const noRelay = { read: async () => [], relayAuthor: "c".repeat(64) };
const artifacts = { version: 1, revision_kind: 45010, modes: ["current"] };

describe("relay support", () => {
  it("needs NIP-CL and NIP-AR as each advertises itself, and nothing more", () => {
    expect(
      configSupport({ supported_extensions: ["nip-cl", "nip-ar"], artifacts }),
    ).toEqual({ supported: true, maxEventBytes: ARTIFACT_MAX_EVENT_BYTES });
    expect(
      configSupport({ supported_extensions: ["nip-ar"], artifacts }),
    ).toMatchObject({ supported: false });
    expect(
      configSupport({ supported_extensions: ["nip-cl"], artifacts }),
    ).toMatchObject({ supported: false });
    expect(
      configSupport({ supported_extensions: ["nip-cl", "nip-ar"] }),
    ).toMatchObject({ supported: false });
    expect(configSupport(null)).toMatchObject({ supported: false });
  });

  it("keeps signed artifacts within a smaller advertised frame", () => {
    expect(
      configSupport({
        supported_extensions: ["nip-cl", "nip-ar"],
        artifacts,
        limitation: { max_message_length: 262_144 },
      }),
    ).toEqual({ supported: true, maxEventBytes: 262_144 - 16 });
  });
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Agent config",
    channelType: "system",
    creator: owner,
    labels: ["agent-config", agent],
    ...overrides,
  } as ChannelSummary;
}

function fakeSession(found: ChannelSummary[][]) {
  const findLabeled = vi.fn(async () => found.shift() ?? []);
  const create = vi.fn(async () => "22222222-2222-4222-8222-222222222222");
  const session = {
    channels: { findLabeled },
    channelCreation: { create },
    channelLifecycle: { available: true, run: vi.fn(async () => {}) },
  } as unknown as RelaySession;
  return { session, findLabeled, create };
}

describe("config channels", () => {
  it("selects the oldest verified config channel, archived included, never by label alone", async () => {
    const oldest = channel({ archived: true });
    const { session, findLabeled } = fakeSession([
      [
        channel({ id: "x", channelType: "stream" }),
        channel({ id: "y", creator: agent }),
        channel({ id: "z", labels: [agent] }),
        oldest,
        channel({ id: "newer" }),
      ],
    ]);
    const found = await createConfigChannels(session, owner, noRelay).find(
      "agent-config",
      agent,
    );
    expect(found).toEqual({
      id: oldest.id,
      archived: true,
      members: undefined,
    });
    // The family label never shares the subject's #t filter.
    expect(findLabeled).toHaveBeenCalledWith(
      { creator: owner, label: agent },
      { consistency: "strong" },
    );
  });

  it("creates a private system channel with both labels only when none is found", async () => {
    const label = await teamSubject("team-1");
    const created = channel({
      id: "22222222-2222-4222-8222-222222222222",
      labels: ["team-config", label],
    });
    const { session, create } = fakeSession([[], [created]]);
    const result = await createConfigChannels(session, owner, noRelay).ensure(
      "team-config",
      label,
      "Team config",
    );
    expect(create).toHaveBeenCalledWith({
      name: "Team config",
      visibility: "private",
      labels: ["team-config", label],
      system: true,
    });
    expect(result.id).toBe(created.id);
  });

  it("lists each team channel under its subject label, never the family label", async () => {
    const label = await teamSubject("team-1");
    const created = channel({
      id: "22222222-2222-4222-8222-222222222222",
      labels: ["team-config", label],
    });
    const { session } = fakeSession([[created]]);
    const teams = await createConfigChannels(session, owner, noRelay).teams();
    expect(teams).toEqual([expect.objectContaining({ id: created.id, label })]);
  });

  it("reuses an existing channel without creating", async () => {
    const { session, create } = fakeSession([[channel({})]]);
    await createConfigChannels(session, owner, noRelay).ensure(
      "agent-config",
      agent,
      "Agent config",
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("import identity", () => {
  it("derives the namespace and team id from the fixed name bytes", async () => {
    // Golden values from Python's uuid.uuid5.
    expect(
      await uuidv5(
        "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        "https://buzz.block.xyz/ns/team-import/v1",
      ),
    ).toBe(BUZZ_TEAM_IMPORT_NS);
    const input = {
      owner: "A".repeat(64),
      community: "11111111-1111-4111-8111-111111111111",
      source: "local-team",
      sourceId: "beta-team-1",
    } as const;
    expect(await importedTeamId(input)).toBe(
      "41c93f26-99b4-549e-87d2-e94d97b1246c",
    );
    expect(
      await importedTeamId({ ...input, source: "old-buzz-team" }),
    ).not.toBe("41c93f26-99b4-549e-87d2-e94d97b1246c");
  });
});

describe("config channel membership and lifecycle", () => {
  const me = keypair();
  const relay = keypair();
  const botKey = keypair();
  const bot = botKey.pubkey;
  const id = "11111111-1111-4111-8111-111111111111";
  /** The agent's profile with a NIP-OA `auth` tag signed by `by` under `conditions`. */
  const profile = (by = me, conditions = "") =>
    signed(botKey, {
      kind: 0,
      content: "{}",
      tags: [
        [
          "auth",
          by.pubkey,
          conditions,
          bytesToHex(
            schnorr.sign(
              new Uint8Array(
                createHash("sha256")
                  .update(`nostr:agent-auth:${bot}:${conditions}`)
                  .digest(),
              ),
              by.secret,
            ),
          ),
        ],
      ],
    });

  /** The real member administration over a channel of `type` where the
   * viewer holds `mine` and the agent `theirs` (none: not a member). */
  function members(
    publish: (event: RelayEvent) => "applied" | "ignored",
    {
      type = "system",
      mine = "owner",
      theirs = "bot" as string | null,
      profiles = [profile()],
    } = {},
  ) {
    let botRole: string | undefined = theirs ?? undefined;
    const elevated = mine === "owner" || mine === "admin";
    const roster = () => [
      signed(relay, {
        kind: 39000,
        content: "",
        tags: [["d", id], ["t", type], ["private"]],
      }),
      signed(relay, {
        kind: 39001,
        content: "",
        tags: [["d", id], ...(elevated ? [["p", me.pubkey, mine]] : [])],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", id],
          ["p", me.pubkey, "", mine],
          ...(botRole ? [["p", bot, "", botRole]] : []),
        ],
      }),
    ];
    const admin = createMemberAdministration({
      reader: { read: async () => roster() } as never,
      writer: {
        sign: async (template: EventTemplate) => signed(me, template),
        publish: async (event: RelayEvent) => {
          if (publish(event) !== "applied") return;
          // The relay records exactly the requested role (side_effects.rs
          // handle_put_user).
          botRole =
            event.kind === 9001
              ? undefined
              : event.tags.find(([key]) => key === "role")?.[1];
        },
      } as never,
      viewer: me.pubkey,
      relayAuthor: relay.pubkey,
      canAccess: () => true,
      acceptDiscovery() {},
    });
    const session = {
      memberAdministration: admin.capability,
    } as unknown as RelaySession;
    return createConfigChannels(session, me.pubkey, {
      read: async () => profiles,
      relayAuthor: relay.pubkey,
    });
  }

  it("adds a non-member to a system channel as member, confirmed by readback", async () => {
    const published: RelayEvent[] = [];
    const channels = members(
      (event) => {
        published.push(event);
        return "applied";
      },
      { theirs: null },
    );
    expect(await channels.addMember(id, bot)).toEqual({ status: "confirmed" });
    expect(published.map((e) => [e.kind, e.tags])).toEqual([
      [
        9000,
        [
          ["h", id],
          ["p", bot],
          ["role", "member"],
        ],
      ],
    ]);
  });

  it("refuses an add on a stream channel, by a plain member, or for an existing member", async () => {
    const publish = vi.fn(() => "applied" as const);
    for (const options of [
      { type: "stream", theirs: null },
      { mine: "member", theirs: null },
      { theirs: "guest" },
    ]) {
      const result = await members(publish, options).addMember(id, bot);
      expect(result.status).not.toBe("uncertain");
      if (options.theirs) expect(result).toEqual({ status: "confirmed" });
      else expect(result.status).toBe("failed");
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses to add an agent this owner can't prove it owns", async () => {
    const publish = vi.fn(() => "applied" as const);
    for (const profiles of [
      [],
      [profile(keypair())],
      [profile(me, "kind=1")],
      [profile(me, "created_at<1")],
      [{ ...profile(), tags: [...profile().tags, ...profile().tags] }],
    ]) {
      expect(
        await members(publish, { theirs: null, profiles }).addMember(id, bot),
      ).toEqual({ status: "failed", error: "Not an agent you own" });
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports uncertain when readback still lacks the added agent", async () => {
    const channels = members(() => "ignored", { theirs: null });
    expect(await channels.addMember(id, bot)).toMatchObject({
      status: "uncertain",
    });
  });

  it("removes the agent with its verified bot role and confirms by readback", async () => {
    const published: RelayEvent[] = [];
    const channels = members((event) => {
      published.push(event);
      return "applied";
    });
    expect(await channels.removeMember(id, bot)).toEqual({
      status: "confirmed",
    });
    expect(published.map((e) => e.kind)).toEqual([9001]);
  });

  it("reports uncertain when readback can't confirm a published removal", async () => {
    const channels = members(() => "ignored");
    expect(await channels.removeMember(id, bot)).toMatchObject({
      status: "uncertain",
    });
  });

  it("reports failed when the relay refuses the removal", async () => {
    const channels = members(() => {
      throw new PublishRejected("restricted: no");
    });
    expect(await channels.removeMember(id, bot)).toMatchObject({
      status: "failed",
    });
  });

  it("answers archived only from one strong relay-signed metadata event", async () => {
    const meta = (tags: string[][], by = relay) =>
      signed(by, { kind: 39000, content: "", tags: [["d", id], ...tags] });
    let answer: RelayEvent[] = [];
    const read = vi.fn(async () => answer);
    const channels = createConfigChannels({} as RelaySession, me.pubkey, {
      read,
      relayAuthor: relay.pubkey,
    });
    answer = [meta([["archived", "true"]])];
    expect(await channels.archived(id)).toBe(true);
    expect(read).toHaveBeenCalledWith(
      [expect.objectContaining({ "#d": [id], consistency: "strong" })],
      expect.anything(),
    );
    answer = [meta([])];
    expect(await channels.archived(id)).toBe(false);
    for (const wrong of [[], [meta([], me)], [meta([]), meta([])]]) {
      answer = wrong;
      await expect(channels.archived(id)).rejects.toThrow();
    }
  });
});
