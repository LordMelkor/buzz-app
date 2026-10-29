import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import { selectProfiles } from "./profile-selection";
import { foldProfiles } from "./profiles";
import { createProfileDirectory } from "./profile-directory";
import {
  createRelayReader,
  type RelayReader,
  type ReadOptions,
} from "./reader";
import { keypair, profile, scriptedTransport, signed } from "./testing";
const user = keypair();
it("projects about safely and publishes an about-only replacement/removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic", about: "First" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    expect(before?.about).toBe("First");
    directory.accept([profile(user, { name: "Mic", about: "Second" }, 2)]);
    expect(directory.queries.snapshot().get(user.pubkey)?.about).toBe("Second");
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.about,
    ).toBeUndefined();
    expect(
      foldProfiles([
        profile(user, { name: "Mic", about: { unsafe: true } }),
      ]).get(user.pubkey),
    ).toEqual({ name: "Mic" });
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("publishes an agent-marker-only profile change and its removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    directory.accept([
      signed(user, {
        kind: 0,
        content: JSON.stringify({ name: "Mic" }),
        created_at: 2,
        tags: [["auth", "a".repeat(64), "", "b".repeat(128)]],
      }),
    ]);
    expect(directory.queries.snapshot().get(user.pubkey)?.isAgent).toBe(true);
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.isAgent,
    ).toBeUndefined();
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("retains self-authored agent metadata without inferring it from display names", () => {
  const author = keypair();
  const profiles = foldProfiles([
    signed(author, {
      kind: 0,
      content: JSON.stringify({ name: "Agent-looking human", is_agent: true }),
      tags: [],
    }),
  ]);
  expect(profiles.get(author.pubkey)?.isAgent).toBe(true);
});

it.each([
  { field: "is_agent", removal: { is_agent: false } },
  { field: "isAgent", removal: {} },
])(
  "notifies the directory and selected profile on $field-only addition/removal",
  ({ field, removal }) => {
    const wire = scriptedTransport(user.pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const selection = selectProfiles(directory.queries, [user.pubkey]);
    const directoryChanged = vi.fn();
    const selectedChanged = vi.fn();
    const unsubscribeDirectory = directory.queries.subscribe(directoryChanged);
    const unsubscribeSelection = selection.subscribe(selectedChanged);
    try {
      directory.accept([profile(user, { name: "Mic" }, 1)]);
      const before = selection.snapshot();
      directoryChanged.mockClear();
      selectedChanged.mockClear();

      directory.accept([profile(user, { name: "Mic", [field]: true }, 2)]);
      const added = selection.snapshot();
      expect(added).not.toBe(before);
      expect(added.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(added.get(user.pubkey)).toEqual({ name: "Mic", isAgent: true });
      expect(directoryChanged).toHaveBeenCalledTimes(1);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      // A newer event with identical display values must still preserve identity.
      // The directory still notifies: its winning signed event changed.
      directory.accept([profile(user, { name: "Mic", [field]: true }, 3)]);
      expect(selection.snapshot()).toBe(added);
      expect(directoryChanged).toHaveBeenCalledTimes(2);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      directory.accept([profile(user, { name: "Mic", ...removal }, 4)]);
      const removed = selection.snapshot();
      expect(removed).not.toBe(added);
      expect(removed.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(removed.get(user.pubkey)).toEqual({ name: "Mic" });
      expect(directoryChanged).toHaveBeenCalledTimes(3);
      expect(selectedChanged).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeSelection();
      unsubscribeDirectory();
      directory.dispose();
      reader.dispose();
    }
  },
);

it("publishes owner-only changes and removal without treating profile claims as authority", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const changed = vi.fn();
  directory.queries.subscribe(changed);
  try {
    for (const [index, owner] of [
      "a".repeat(64),
      "b".repeat(64),
      undefined,
    ].entries()) {
      directory.accept([
        signed(user, {
          kind: 0,
          content: JSON.stringify({ name: "Honey", is_agent: true }),
          created_at: index + 1,
          tags: owner ? [["auth", owner, "", "c".repeat(128)]] : [],
        }),
      ]);
      expect(directory.queries.snapshot().get(user.pubkey)?.ownerPubkey).toBe(
        owner,
      );
      expect(changed).toHaveBeenCalledTimes(index + 1);
    }
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("notifies once for a batch of verified owner attestations", async () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const owner = keypair();
  const agents = [keypair(), keypair(), keypair()];
  const changed = vi.fn();
  directory.queries.subscribe(changed);
  try {
    directory.accept(
      agents.map((agent) => {
        const digest = createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest();
        const sig = schnorr.sign(new Uint8Array(digest), owner.secret);
        return eventDto(
          signed(agent, {
            kind: 0,
            content: JSON.stringify({ name: "Agent", is_agent: true }),
            tags: [["auth", owner.pubkey, "", bytesToHex(sig)]],
          }),
        );
      }),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        agents.map((agent) => directory.queries.owner?.(agent.pubkey)),
      ).toEqual(agents.map(() => owner.pubkey)),
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("reacts to NIP-05-only replacements and removal without asserting verification", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const selection = selectProfiles(directory.queries, [user.pubkey]);
  const changed = vi.fn();
  const unsubscribe = selection.subscribe(changed);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = selection.snapshot();
    changed.mockClear();
    directory.accept([
      profile(user, { name: "Mic", nip05: "  mic@example.org  " }, 2),
    ]);
    expect(selection.snapshot()).not.toBe(before);
    expect(selection.snapshot().get(user.pubkey)?.nip05).toBe(
      "mic@example.org",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: "mic@example.org" }, 3),
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: { unsafe: true } }, 4),
    ]);
    expect(selection.snapshot().get(user.pubkey)).toEqual({ name: "Mic" });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    directory.dispose();
    reader.dispose();
  }
});

it("retains safe inline profile pictures through parsing and media routing", async () => {
  const { mediaUrl } = await import("./transport");
  for (const picture of [
    "data:image/png;base64,AAAA",
    "https://source.example/picture.png",
    "data:image/svg+xml;base64,AAAA",
    "javascript:alert(1)",
    "https://user:password@source.example/picture.png",
    `data:image/png;base64,${"A".repeat(512 * 1024)}`,
  ]) {
    const safe =
      picture === "data:image/png;base64,AAAA" ||
      picture === "https://source.example/picture.png";
    const parsed = foldProfiles([profile(user, { name: "Mic", picture })]).get(
      user.pubkey,
    );
    expect(parsed?.picture).toBe(safe ? picture : undefined);
    if (parsed?.picture)
      expect(mediaUrl(parsed.picture, undefined, undefined)).toBe(picture);
  }
});

it("reuses one event's projection across folds", () => {
  const head = profile(user, { name: "Mic" }, 1);
  const parsed = foldProfiles([head]).get(user.pubkey);
  expect(foldProfiles([head]).get(user.pubkey)).toBe(parsed);
  const next = foldProfiles([head, profile(user, { name: "Mike" }, 2)]);
  expect(next.get(user.pubkey)?.name).toBe("Mike");
});

it("refreshes retained profiles in the background without rolling back signed heads", async () => {
  const old = profile(user, { name: "GLM" }, 1);
  const renamed = profile(user, { name: "Luna" }, 2);
  const read = vi.fn(async () => [renamed]);
  const directory = createProfileDirectory({ read });
  try {
    directory.accept([old]);
    await directory.reconnect();
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [0], authors: [user.pubkey], limit: 500 }],
      expect.objectContaining({ priority: "background" }),
    );
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Luna");
    read.mockResolvedValueOnce([old]);
    await directory.reconnect();
    expect(directory.event(user.pubkey)).toBe(renamed);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Luna");
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(directory.reconnect()).rejects.toThrow("offline");
    expect(directory.event(user.pubkey)).toBe(renamed);
    await directory.reconnect();
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    directory.dispose();
  }
});

it("retires pending profile reads before reconnect and fences cache clear/disposal", async () => {
  const old = profile(user, { name: "GLM" }, 1);
  const renamed = profile(user, { name: "Luna" }, 2);
  let resolve!: (events: (typeof old)[]) => void;
  const read = vi.fn(
    (_filters: Parameters<RelayReader["read"]>[0], _options?: ReadOptions) =>
      new Promise<(typeof old)[]>((done) => {
        resolve = done;
      }),
  );
  const directory = createProfileDirectory({ read });
  const pending = directory.ensure([user.pubkey]);
  const finishOld = resolve;
  try {
    directory.accept([old]);
    const refreshed = directory.reconnect();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve([renamed]);
    await refreshed;
    finishOld([old]);
    await pending;
    expect(directory.event(user.pubkey)).toBe(renamed);

    const cleared = directory.reconnect();
    directory.clear();
    resolve([renamed]);
    await cleared;
    expect(directory.queries.snapshot().size).toBe(0);

    directory.accept([old]);
    const disposed = directory.reconnect();
    directory.dispose();
    resolve([renamed]);
    await disposed;
    expect(directory.queries.snapshot().size).toBe(0);
  } finally {
    directory.dispose();
  }
});

it("promotes a queued background profile read when foreground demand joins it", async () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    // Unrelated background work holds the reader's only background slot.
    const held = reader.reader.read([{ kinds: [3], limit: 1 }], {
      priority: "background",
    });
    const enrichment = directory.ensure([user.pubkey], "background");
    expect(wire.pending).toHaveLength(1);
    const demanded = directory.ensure([user.pubkey], "foreground");
    expect(wire.pending).toHaveLength(2);
    wire.pending[1]?.respond([profile(user, { name: "Mic" })]);
    await Promise.all([enrichment, demanded]);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Mic");
    wire.next().respond([]);
    await held;
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("records identities a completed read found no profile for, until one arrives", async () => {
  const other = keypair();
  const third = keypair();
  const read = vi.fn(async () => [profile(user, { name: "Mic" })]);
  const directory = createProfileDirectory({ read });
  const listener = vi.fn();
  directory.queries.subscribe(listener);
  try {
    await directory.ensure([user.pubkey, other.pubkey]);
    const absent = directory.queries.unnamed?.();
    expect(absent).toEqual(new Set([other.pubkey]));
    // Once for the profile, once for the absence.
    expect(listener).toHaveBeenCalledTimes(2);
    // A failed read is not evidence.
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(directory.ensure([third.pubkey])).rejects.toThrow("offline");
    expect(directory.queries.unnamed?.()).toBe(absent);
    // A profile that arrives later outranks the absence.
    directory.accept([profile(other, { name: "Nu" })]);
    expect(directory.queries.snapshot().get(other.pubkey)?.name).toBe("Nu");
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    // Clearing forgets the evidence and tells subscribers so.
    await directory.ensure([third.pubkey]);
    expect(directory.queries.unnamed?.()).toEqual(new Set([third.pubkey]));
    listener.mockClear();
    directory.clear();
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    expect(listener).toHaveBeenCalled();
  } finally {
    directory.dispose();
  }
});

it("records no absence from a read that filled its page", async () => {
  const other = keypair();
  // A relay that keeps every kind 0 can fill the page from one author. The
  // directory does not verify events, so older versions are cheap copies.
  const head = profile(user, { name: "Mic" }, 1_700_000_500);
  const versions = Array.from({ length: 500 }, (_, i) => ({
    ...head,
    id: i.toString(16).padStart(64, "0"),
    created_at: head.created_at - i,
  }));
  const read = vi.fn(async () => versions);
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure([user.pubkey, other.pubkey]);
    expect(directory.queries.snapshot().get(user.pubkey)?.name).toBe("Mic");
    expect(directory.queries.unnamed?.()).toEqual(new Set());
    // One short of the limit is complete.
    read.mockResolvedValueOnce(versions.slice(1));
    await directory.ensure([other.pubkey]);
    expect(directory.queries.unnamed?.()).toEqual(new Set([other.pubkey]));
  } finally {
    directory.dispose();
  }
});

const hexIds = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) =>
    (from + index).toString(16).padStart(64, "0"),
  );
/** Unsigned heads: the directory trusts its reader to have verified them. */
const named = (pubkey: string) =>
  ({
    id: pubkey,
    pubkey,
    kind: 0,
    created_at: 1,
    tags: [],
    content: JSON.stringify({ name: `Name ${pubkey.slice(-3)}` }),
    sig: "",
  }) as unknown as RelayEvent;
const overBudget = () =>
  new ReadError("invalid-response", "Relay response exceeds the read budget");

it("names the identities that fit a request larger than the cache instead of failing", async () => {
  const ids = hexIds(1100);
  const read = vi.fn(async ([filter]: readonly ReadFilter[]) =>
    (filter?.authors ?? []).map(named),
  );
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure(ids);
    expect(read.mock.calls.map(([[filter]]) => filter?.authors)).toEqual([
      ids.slice(0, 500),
      ids.slice(500, 1000),
      ids.slice(1000, 1024),
    ]);
    expect([...directory.queries.snapshot().keys()].sort()).toEqual(
      ids.slice(0, 1024),
    );
    // Asking again reads nothing, so a retry cannot churn the cache.
    await directory.ensure(ids);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    directory.dispose();
  }
});

it("retries profiles over the read budget in halves from the same author", async () => {
  const ids = hexIds(500);
  const absent = ids[499]!;
  const read = vi.fn(async ([filter]: readonly ReadFilter[]) => {
    const authors = filter?.authors ?? [];
    if (authors.length > 200) throw overBudget();
    // Duplicate heads fill no page but pass the page size in total.
    return authors
      .filter((id) => id !== absent)
      .flatMap((id) => [named(id), named(id)]);
  });
  const directory = createProfileDirectory({ read });
  try {
    await directory.ensure(ids);
    expect(
      read.mock.calls.map(([[filter]]) => [
        ids.indexOf(filter?.authors?.[0] ?? ""),
        filter?.authors?.length,
      ]),
    ).toEqual([
      [0, 500],
      [0, 250],
      [0, 125],
      [125, 125],
      [250, 125],
      [375, 125],
    ]);
    expect(directory.queries.snapshot().size).toBe(499);
    // Every halved page came back short, so the read was complete.
    expect(directory.queries.unnamed?.()).toEqual(new Set([absent]));
    // A read still over the budget at one author fails, after one per halving.
    read.mockClear();
    read.mockImplementation(async () => {
      throw overBudget();
    });
    await expect(directory.ensure(hexIds(500, 500))).rejects.toThrow(
      "Relay response exceeds the read budget",
    );
    expect(
      read.mock.calls.map(([[filter]]) => filter?.authors?.length),
    ).toEqual([500, 250, 125, 63, 32, 16, 8, 4, 2, 1]);
    expect(directory.queries.snapshot().size).toBe(499);
  } finally {
    directory.dispose();
  }
});

it("reports a failed batch only after the request's other batches land", async () => {
  const ids = hexIds(600);
  const read = vi.fn(async ([filter]: readonly ReadFilter[]) => {
    const authors = filter?.authors ?? [];
    // Not a read-budget failure, so the batch fails without halving.
    if (authors.length === 500) throw new ReadError("denied", "Names denied");
    // The other batch lands in a later task than that failure.
    await new Promise((resolve) => setTimeout(resolve));
    return authors.map(named);
  });
  const directory = createProfileDirectory({ read });
  try {
    await expect(directory.ensure(ids)).rejects.toThrow("Names denied");
    expect([...directory.queries.snapshot().keys()].sort()).toEqual(
      ids.slice(500),
    );
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    directory.dispose();
  }
});
