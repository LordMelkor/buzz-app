// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ReadFilter } from "../../features/relay/events";
import { eventDto } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import {
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

it.each([
  ["a verified full name", "rivera"],
  ["a verified username", "jrivera"],
])(
  "resolves from: by %s that differs from the person's profile name",
  async (_case, typed) => {
    const viewer = keypair();
    const relay = keypair();
    const person = keypair();
    const reads: ReadFilter[][] = [];
    const head = signed(relay, {
      kind: 30382,
      created_at: 1_000_000,
      content: "",
      tags: [
        ["d", person.pubkey],
        ["p", person.pubkey],
        ["active", "true"],
        ["display_name", "Jordan"],
        ["username", "jrivera"],
        ["issuer_label", "Example"],
        ["verified_at", "1000000"],
        ["full_name", "Rivera"],
      ],
    });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        searchable: true,
      },
      // The relay matches verified names and sends the head with the profile.
      searchProfiles: async () =>
        [profile(person, { name: "jr-old" }), head].map((event) =>
          eventDto(event),
        ),
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as ReadFilter[]);
        return Promise.resolve([]);
      },
    });
    try {
      const { result } = renderHook(() =>
        useSearchMessages(owner.session, `from:${typed} deploy`),
      );
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [person.pubkey] }),
        ]),
      );
      expect(result.current.ambiguousAuthor).toBeFalsy();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("still resolves from: by a profile name when the verified names cannot be read", async () => {
  const viewer = keypair();
  const relay = keypair();
  const person = keypair();
  const reads: ReadFilter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    searchProfiles: async () => [eventDto(profile(person, { name: "jordan" }))],
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(30382)))
        return Promise.reject(new Error("verified names unavailable"));
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as ReadFilter[]);
      return Promise.resolve([]);
    },
  });
  try {
    renderHook(() => useSearchMessages(owner.session, "from:jordan deploy"));
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [person.pubkey] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not resolve from: by a verified name the shared profiles withdrew during the read", async () => {
  const viewer = keypair();
  const relay = keypair();
  const person = keypair();
  const reads: ReadFilter[][] = [];
  const head = signed(relay, {
    kind: 30382,
    created_at: 1_000_000,
    content: "",
    tags: [
      ["d", person.pubkey],
      ["p", person.pubkey],
      ["active", "true"],
      ["display_name", "Jordan"],
      ["username", "jrivera"],
      ["issuer_label", "Example"],
      ["verified_at", "1000000"],
      ["full_name", "Rivera"],
    ],
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
    searchProfiles: async () =>
      [profile(person, { name: "jr-old" }), head].map((event) =>
        eventDto(event),
      ),
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as ReadFilter[]);
      return Promise.resolve([]);
    },
  });
  // A withdrawal reaches the shared profiles while the names are being read:
  // it holds a head that gives the person no verified name.
  let withdrawn = false;
  const verify = owner.session.directMessages.verified;
  const session = {
    ...owner.session,
    profiles: { ...owner.session.profiles, verifiedHeld: () => withdrawn },
    directMessages: {
      ...owner.session.directMessages,
      verified: async (...args: Parameters<typeof verify>) => {
        const answer = await verify(...args);
        withdrawn = true;
        return answer;
      },
    },
  } as typeof owner.session;
  try {
    const { result } = renderHook(() =>
      useSearchMessages(session, "from:rivera deploy"),
    );
    await waitFor(() => expect(withdrawn).toBe(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not resolve from: by verified names checked by an authority that changed during the read", async () => {
  const viewer = keypair();
  const relay = keypair();
  const person = keypair();
  const reads: ReadFilter[][] = [];
  const head = signed(relay, {
    kind: 30382,
    created_at: 1_000_000,
    content: "",
    tags: [
      ["d", person.pubkey],
      ["p", person.pubkey],
      ["active", "true"],
      ["display_name", "Jordan"],
      ["username", "jrivera"],
      ["issuer_label", "Example"],
      ["verified_at", "1000000"],
      ["full_name", "Rivera"],
    ],
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
    searchProfiles: async () =>
      [profile(person, { name: "jr-old" }), head].map((event) =>
        eventDto(event),
      ),
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as ReadFilter[]);
      return Promise.resolve([]);
    },
  });
  // The community withdraws its verified names while they are being read.
  const authority = owner.session.profiles.verifiedAuthority?.();
  let current = authority;
  const verify = owner.session.directMessages.verified;
  const session = {
    ...owner.session,
    profiles: { ...owner.session.profiles, verifiedAuthority: () => current },
    directMessages: {
      ...owner.session.directMessages,
      verified: async (...args: Parameters<typeof verify>) => {
        const answer = await verify(...args);
        current = undefined;
        return answer;
      },
    },
  } as typeof owner.session;
  try {
    const { result } = renderHook(() =>
      useSearchMessages(session, "from:rivera deploy"),
    );
    await waitFor(() => expect(current).toBeUndefined());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("resolves from: again when the verification authority is replaced during the read", async () => {
  const viewer = keypair();
  const relay = keypair();
  const person = keypair();
  const reads: ReadFilter[][] = [];
  const head = signed(relay, {
    kind: 30382,
    created_at: 1_000_000,
    content: "",
    tags: [
      ["d", person.pubkey],
      ["p", person.pubkey],
      ["active", "true"],
      ["display_name", "Jordan"],
      ["username", "jrivera"],
      ["issuer_label", "Example"],
      ["verified_at", "1000000"],
      ["full_name", "Rivera"],
    ],
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
    searchProfiles: async () =>
      [profile(person, { name: "jr-old" }), head].map((event) =>
        eventDto(event),
      ),
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as ReadFilter[]);
      return Promise.resolve([]);
    },
  });
  // The community re-advertises its authority while the first read runs.
  const original = owner.session.profiles.verifiedAuthority?.();
  let current = original;
  const listeners = new Set<() => void>();
  const verify = owner.session.directMessages.verified;
  const session = {
    ...owner.session,
    profiles: {
      ...owner.session.profiles,
      verifiedAuthority: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    directMessages: {
      ...owner.session.directMessages,
      verified: async (...args: Parameters<typeof verify>) => {
        const answer = await verify(...args);
        if (current !== original) return { ...answer, authority: current };
        current = original && { ...original };
        queueMicrotask(() => {
          for (const listener of listeners) listener();
        });
        return answer;
      },
    },
  } as typeof owner.session;
  try {
    renderHook(() => useSearchMessages(session, "from:rivera deploy"));
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [person.pubkey] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not resolve from: by a verified name whose newer shared head arrived during the search", async () => {
  const viewer = keypair();
  const relay = keypair();
  const person = keypair();
  const reads: ReadFilter[][] = [];
  const head = signed(relay, {
    kind: 30382,
    created_at: 1_000_000,
    content: "",
    tags: [
      ["d", person.pubkey],
      ["p", person.pubkey],
      ["active", "true"],
      ["display_name", "Jordan"],
      ["username", "jrivera"],
      ["issuer_label", "Example"],
      ["verified_at", "1000000"],
      ["full_name", "Rivera"],
    ],
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
    searchProfiles: async () =>
      [profile(person, { name: "jr-old" }), head].map((event) =>
        eventDto(event),
      ),
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as ReadFilter[]);
      return Promise.resolve([]);
    },
  });
  // While the search runs, the shared profiles accept a newer head for the
  // person (a withdrawal), then evict it, so only its revision remains.
  let revision = 0;
  let accepted = 0;
  let searched = false;
  const search = owner.session.searchProfiles;
  const session = {
    ...owner.session,
    searchProfiles: async (...args: Parameters<typeof search>) => {
      const found = await search(...args);
      accepted = revision = 1;
      searched = true;
      return found;
    },
    profiles: {
      ...owner.session.profiles,
      verifiedRevision: () => revision,
      verifiedSince: (pubkey: string, since: number) =>
        pubkey === person.pubkey && accepted > since,
    },
  } as typeof owner.session;
  try {
    const { result } = renderHook(() =>
      useSearchMessages(session, "from:rivera deploy"),
    );
    await waitFor(() => expect(searched).toBe(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["", true],
  [" before that member's verified head is cached", false],
])(
  "reports from: as ambiguous when a member's own profile name matches another member's verified username%s",
  async (_name, cached) => {
    const viewer = keypair();
    const relay = keypair();
    const alex = keypair();
    const bobby = keypair();
    const reads: ReadFilter[][] = [];
    const discovery = [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey, alex.pubkey, bobby.pubkey]),
      eventDto(
        signed(relay, {
          kind: 30382,
          created_at: 1_000_000,
          content: "",
          tags: [
            ["d", alex.pubkey],
            ["p", alex.pubkey],
            ["active", "true"],
            ["display_name", "Alex"],
            ["username", "jrivera"],
            ["issuer_label", "Example"],
            ["verified_at", "1000000"],
          ],
        }),
      ),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        searchable: true,
      },
      searchProfiles: async () => [],
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9))) {
          reads.push(filters as ReadFilter[]);
          return Promise.resolve([]);
        }
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    });
    // Shared profiles name a verified person by their verified label; their
    // own profile name stays in their profile event.
    const verified = (displayName: string, username: string) => ({
      displayName,
      username,
      issuerLabel: "Example",
      verifiedAt: 1,
      status: "checked" as const,
      multipleIssuers: false,
    });
    // Uncached, the shared profiles know Alex only by their profile name.
    const shared = new Map([
      [
        alex.pubkey,
        cached
          ? { name: "Alex", verified: verified("Alex", "jrivera") }
          : { name: "alex" },
      ],
      [bobby.pubkey, { name: "Bobby", verified: verified("Bobby", "bobby") }],
    ]);
    const events = new Map([
      [alex.pubkey, profile(alex, { name: "alex" })],
      [bobby.pubkey, profile(bobby, { name: "jrivera" })],
    ]);
    const session = {
      ...owner.session,
      profiles: {
        ...owner.session.profiles,
        ensure: async () => {},
        snapshot: () => shared,
        event: (pubkey: string) => events.get(pubkey),
        verifiedHeld: () => false,
      },
    } as unknown as typeof owner.session;
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")?.members).toHaveLength(3),
      );
      const { result } = renderHook(() =>
        useSearchMessages(session, "from:jrivera deploy", "crew"),
      );
      await waitFor(() => expect(result.current.ambiguousAuthor).toBe(true));
      expect(reads).toEqual([]);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);
