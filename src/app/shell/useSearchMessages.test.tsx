// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import {
  type Key,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import { useSearchMessages } from "./useSearchMessages";

it.each([
  { count: 0, scope: "crew", dropped: false },
  { count: 19, scope: "crew", dropped: false },
  { count: 20, scope: "crew", dropped: false },
  { count: 20, scope: undefined, dropped: true },
  { count: 20, scope: "crew", dropped: true },
])(
  "pages $count relay hits with scope=$scope and dropped=$dropped while preserving queued messages",
  async ({ count, scope, dropped }) => {
    const viewer = keypair();
    const relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const queued = Array.from({ length: 20 }, (_, index) => ({
      event: message(viewer, "crew", `queued ${index}`, 1700000100 + index),
      delivery: "unknown" as const,
    }));
    const discovery = [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          sign: async (template) => signed(viewer, template),
          publish: async () => {},
        },
        query(filters, signal) {
          if (filters.some((filter) => filter.kinds?.includes(9)))
            return wire.transport.query(filters, signal);
          return Promise.resolve(
            discovery.filter((event) =>
              filters.some((filter) => filter.kinds?.includes(event.kind)),
            ),
          );
        },
      },
      { outboxStorage: { load: () => queued, save() {} } },
    );
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")).toBeDefined(),
      );
      const { result } = renderHook(() =>
        useSearchMessages(owner.session, "before:2026-10-01", scope),
      );
      await waitFor(() => expect(wire.pending).toHaveLength(1));
      const first = wire.next();
      expect(first.filters).toEqual([
        {
          kinds: [40002, 40008, 9],
          limit: 20,
          ...(scope ? { "#h": [scope] } : {}),
          until: expect.any(Number),
        },
      ]);
      await act(async () =>
        first.respond([
          ...Array.from({ length: count - Number(dropped) }, (_, index) =>
            message(viewer, "crew", `remote ${index}`, 1700000000 + index),
          ),
          ...(dropped
            ? [message(viewer, "ghost", "inaccessible", 1700000000)]
            : []),
        ]),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.messages).toHaveLength(
        20 + count - Number(dropped),
      );
      expect(
        result.current.messages.some(({ channelId }) => channelId === "ghost"),
      ).toBe(false);
      expect(result.current.hasMore).toBe(count === 20);
      if (count === 20) {
        act(() => result.current.loadMore());
        await waitFor(() => expect(wire.pending).toHaveLength(1));
        const next = wire.next();
        expect(next.filters).toEqual([{ ...first.filters[0], page: 2 }]);
        await act(async () =>
          next.respond(
            dropped
              ? [message(viewer, "crew", "older page two hit", 1699999999)]
              : [],
          ),
        );
        await waitFor(() => expect(result.current.loadingMore).toBe(false));
        expect(result.current.hasMore).toBe(false);
        expect(result.current.messages).toHaveLength(20 + count);
        if (dropped)
          expect(result.current.messages.at(-1)?.preview).toBe(
            "older page two hit",
          );
      }
      expect(
        result.current.messages.filter(({ preview }) =>
          preview.startsWith("queued "),
        ),
      ).toHaveLength(20);
      expect(result.current.error).toBeUndefined();
      expect(result.current.moreError).toBeUndefined();
      act(() => result.current.loadMore());
      expect(wire.pending).toHaveLength(0);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves from:name on a roster larger than the profile budget when some names fail", async () => {
  const viewer = keypair();
  const relay = keypair();
  const alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const members = [
    viewer.pubkey,
    alice.pubkey,
    // Keys just above Alice's sort after hers, so she is in the first batch.
    ...Array.from({ length: 1098 }, (_, index) =>
      (BigInt(`0x${alice.pubkey}`) + BigInt(index + 1))
        .toString(16)
        .padStart(64, "0"),
    ),
  ];
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", members),
  ];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
      query(filters, signal) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          return wire.transport.query(filters, signal);
        const names = filters.find((filter) => filter.kinds?.includes(0));
        // The failed batches leave the names partial, so a name search over
        // their members checks for a namesake among them.
        if (names)
          return names.authors?.includes(alice.pubkey)
            ? Promise.resolve([profile(alice, { name: "Alice" })])
            : names.search
              ? Promise.resolve([])
              : Promise.reject(new Error("Names unavailable"));
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.get?.("crew")?.members).toHaveLength(1100),
    );
    const { result } = renderHook(() =>
      useSearchMessages(owner.session, "from:alice ", "crew"),
    );
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    const read = wire.next();
    expect(read.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        limit: 20,
        "#h": ["crew"],
        authors: [alice.pubkey],
      },
    ]);
    await act(async () =>
      read.respond([message(alice, "crew", "hello", 1700000000)]),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.map(({ preview }) => preview)).toEqual([
      "hello",
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

/** A key whose hex starts with `digit`, so it sorts to a known side of the
 * 1,024-id profile budget. */
function keyStarting(digit: string) {
  for (;;) {
    const key = keypair();
    if (key.pubkey.startsWith(digit)) return key;
  }
}

/** A session that has joined "crew" with `members`. Author reads answer from
 * `profiles` and the relay's name search answers `found`, within its
 * `authors` when it has them. */
async function crew(
  members: readonly string[],
  profiles: readonly RelayEvent[],
  found: readonly RelayEvent[],
) {
  const viewer = keypair();
  const relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const requested = new Set<string>();
  const searches: ReadFilter[] = [];
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, ...members]),
  ];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
      query(filters, signal) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          return wire.transport.query(filters, signal);
        const names = filters.find((filter) => filter.kinds?.includes(0));
        if (names?.search) {
          searches.push(names);
          return Promise.resolve(
            found.filter(
              (event) => !names.authors || names.authors.includes(event.pubkey),
            ),
          );
        }
        if (names) {
          for (const author of names.authors ?? []) requested.add(author);
          return Promise.resolve(
            profiles.filter((event) => names.authors?.includes(event.pubkey)),
          );
        }
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owner.session.channels.ensureList();
  await waitFor(() =>
    expect(owner.session.channels.get?.("crew")?.members).toHaveLength(
      members.length + 1,
    ),
  );
  return { owner, wire, requested, searches };
}

const near = keyStarting("1");
const far = keyStarting("f");
const outsider = keypair();
const alice = (key: Key) => profile(key, { name: "Alice" });
// 1,097 keys between the two, so the roster passes the profile budget with
// `near` inside it and `far` past it.
const between = Array.from(
  { length: 1097 },
  (_, index) => `5${index.toString(16).padStart(63, "0")}`,
);

const outsiders = Array.from({ length: 39 }, () => keypair());

it.each([
  {
    roster: "namesakes on both sides of the budget",
    named: [near, far],
    found: [near, far],
    author: undefined,
    unreadOnly: true,
  },
  {
    roster: "only the member past the budget",
    named: [far],
    found: [far],
    author: far,
    unreadOnly: false,
  },
  {
    roster: "a named member and a namesake outside the channel",
    named: [near],
    found: [near, outsider],
    author: near,
    unreadOnly: true,
  },
  {
    // A relay-wide search would return a full page of 40 Alices.
    roster: "a named member and 39 namesakes outside the channel",
    named: [near],
    found: [near, ...outsiders],
    author: near,
    unreadOnly: true,
  },
])(
  "resolves from:name on $roster",
  async ({ named, found, author, unreadOnly }) => {
    const { owner, wire, requested, searches } = await crew(
      [near.pubkey, ...between, far.pubkey],
      named.map(alice),
      found.map(alice),
    );
    try {
      const { result } = renderHook(() =>
        useSearchMessages(owner.session, "from:alice ", "crew"),
      );
      if (author) {
        await waitFor(() => expect(wire.pending).toHaveLength(1));
        const read = wire.next();
        expect(read.filters[0]?.authors).toEqual([author.pubkey]);
        await act(async () => read.respond([]));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.ambiguousAuthor).toBeUndefined();
      } else {
        await waitFor(() => expect(result.current.ambiguousAuthor).toBe(true));
        expect(wire.pending).toHaveLength(0);
      }
      expect(requested.has(near.pubkey)).toBe(true);
      expect(requested.has(far.pubkey)).toBe(false);
      expect(searches).toHaveLength(1);
      // Beside a loaded match only the members whose names did not load are
      // searched; otherwise the relay-wide name search runs.
      const authors = searches[0]?.authors;
      expect(authors?.includes(far.pubkey) ?? false).toBe(unreadOnly);
      expect(authors?.includes(near.pubkey) ?? false).toBe(false);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("treats a full page of member name matches past the budget as ambiguous", async () => {
  // Forty members past the budget whose profiles match the typed prefix
  // without naming Alice fill the page, so another Alice may be on the next.
  const crowd = Array.from({ length: 40 }, () => keyStarting("f"));
  const { owner, wire, searches } = await crew(
    [near.pubkey, ...between.slice(0, 1057), ...crowd.map((key) => key.pubkey)],
    [alice(near)],
    crowd.map((key) => profile(key, { name: "Alice Smith" })),
  );
  try {
    const { result } = renderHook(() =>
      useSearchMessages(owner.session, "from:alice ", "crew"),
    );
    await waitFor(() => expect(result.current.ambiguousAuthor).toBe(true));
    expect(wire.pending).toHaveLength(0);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.authors).toEqual(
      expect.arrayContaining(crowd.map((key) => key.pubkey)),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("searches the members whose names did not load in parts that fit the filter budget", async () => {
  // 1,925 roster keys, so 901 are past the 1,024-id profile budget.
  const many = Array.from(
    { length: 1922 },
    (_, index) => `5${index.toString(16).padStart(63, "0")}`,
  );
  const { owner, wire, searches } = await crew(
    [near.pubkey, ...many, far.pubkey],
    [alice(near)],
    [alice(near), alice(far)],
  );
  try {
    const { result } = renderHook(() =>
      useSearchMessages(owner.session, "from:alice ", "crew"),
    );
    await waitFor(() => expect(result.current.ambiguousAuthor).toBe(true));
    expect(wire.pending).toHaveLength(0);
    expect(searches.map(({ authors }) => authors?.length).sort()).toEqual([
      1, 900,
    ]);
    expect(searches.flatMap(({ authors }) => authors ?? [])).toContain(
      far.pubkey,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("resolves from:name on a fully read roster without a relay name search", async () => {
  // The viewer and a member the relay answered without a profile are known
  // unnamed, not missing.
  const { owner, wire, searches } = await crew(
    [near.pubkey, between[0] ?? ""],
    [alice(near)],
    [alice(near)],
  );
  try {
    const { result } = renderHook(() =>
      useSearchMessages(owner.session, "from:alice ", "crew"),
    );
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    const read = wire.next();
    expect(read.filters[0]?.authors).toEqual([near.pubkey]);
    await act(async () => read.respond([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(searches).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});
