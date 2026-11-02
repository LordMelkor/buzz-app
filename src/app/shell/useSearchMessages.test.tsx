// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
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
