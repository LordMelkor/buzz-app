import { describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, profile, roster, scriptedTransport } from "./testing";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";

type Mode = "nip50" | "endpoint";
/** `endpoint` gives the transport the relay's name-only profile search. Its
 * requests join the same script as NIP-50 reads, and `query` counts both. */
function setup(mode: Mode = "nip50") {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const query = vi.fn(wire.transport.query);
  const searchProfiles = vi.fn(
    (text: string, limit: number, page: number, signal: AbortSignal) =>
      query(
        [{ kinds: [0], search: text, search_mode: "prefix", limit, page }],
        signal,
      ),
  );
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    query,
    ...(mode === "endpoint" ? { searchProfiles } : {}),
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  live.receive([roster(relay, "general", [viewer.pubkey])]);
  let revision = 1_700_000_000;
  const revoke = () => {
    live.receive([roster(relay, "general", [viewer.pubkey], ++revision)]);
    live.receive([roster(relay, "general", [], ++revision)]);
  };
  return { owner, live, wire, query, searchProfiles, person, revoke };
}
// Browsing ("") never uses name search, so endpoint cases search by name.
const cases = [
  ["nip50", ""],
  ["endpoint", "Person"],
] as const;
describe.each(cases)("%s directory", (mode, text) => {
  it.each(["pending", "resolved"] as const)(
    "retries one %s directory page invalidated by signed access loss",
    async (ordering) => {
      const h = setup(mode);
      try {
        const pending = h.owner.session.directMessages.people(
          "Person",
          2,
          new AbortController().signal,
        );
        void pending.catch(() => {}); // A broken recovery must fail assertions, not leak a rejection.
        const first = h.wire.next();
        if (ordering === "resolved") {
          first.respond([profile(h.person, { name: "Obsolete" })]);
          queueMicrotask(h.revoke);
        } else h.revoke();
        await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
        const replacement = h.wire.next();
        expect(replacement.filters).toEqual(first.filters);
        replacement.respond([profile(h.person, { name: "Person" })]);
        expect(await pending).toEqual({
          people: [{ pubkey: h.person.pubkey, name: "Person" }],
          hasMore: false,
        });
        expect(
          h.owner.session.profiles.snapshot().get(h.person.pubkey),
        ).toBeUndefined();
        expect(h.searchProfiles).toHaveBeenCalledTimes(
          mode === "endpoint" ? 2 : 0,
        );
      } finally {
        h.owner.dispose();
      }
    },
  );
  it.each(["access", "caller", "dispose", "cache", "disconnect"] as const)(
    "does not retry a recovered directory page again after %s",
    async (boundary) => {
      const h = setup(mode);
      const caller = new AbortController();
      try {
        const pending = h.owner.session.directMessages.people(
          text,
          1,
          caller.signal,
        );
        const result = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const first = h.wire.next();
        h.revoke();
        await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
        const replacement = h.wire.next();
        expect(first.signal?.aborted).toBe(true);
        if (boundary === "access") h.revoke();
        else if (boundary === "caller") caller.abort();
        else if (boundary === "dispose") h.owner.dispose();
        else if (boundary === "cache") await h.owner.clearCache();
        else h.live.state({ status: "connecting", routes: [] });
        expect(await result).toMatchObject({ error: { name: "AbortError" } });
        expect(replacement.signal?.aborted).toBe(true);
        expect(h.query).toHaveBeenCalledTimes(2);
        expect(h.wire.pending).toHaveLength(0);
      } finally {
        h.owner.dispose();
      }
    },
  );
  it.each([
    "caller",
    "dispose",
    "cache",
    "disconnect",
    "denied",
    "network",
    "abort",
  ] as const)(
    "does not recover a directory failure caused by %s",
    async (boundary) => {
      const h = setup(mode);
      const caller = new AbortController();
      try {
        const pending = h.owner.session.directMessages.people(
          text,
          1,
          caller.signal,
        );
        const rejected = expect(pending).rejects.toThrow();
        const first = h.wire.next();
        if (["caller", "dispose", "cache", "disconnect"].includes(boundary)) {
          // Explicit cancellation wins even if an access change happened first.
          h.revoke();
          if (boundary === "caller") caller.abort();
          else if (boundary === "dispose") h.owner.dispose();
          else if (boundary === "cache") await h.owner.clearCache();
          else h.live.state({ status: "connecting", routes: [] });
        } else
          first.fail(
            boundary === "denied"
              ? new ReadError("denied", "Denied", 403)
              : boundary === "network"
                ? new Error("Network failed")
                : new DOMException("Adapter aborted", "AbortError"),
          );
        await rejected;
        expect(h.query).toHaveBeenCalledTimes(1);
        expect(h.wire.pending).toHaveLength(0);
      } finally {
        h.owner.dispose();
      }
    },
  );
  it("retries a lasting transient failure quietly at most three times", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = setup(mode);
    try {
      const pending = h.owner.session.directMessages.people(
        text,
        1,
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toMatchObject({ status: 502 });
      // Equal jitter at 0.5 waits 750 ms, 1.5 s and 3 s between attempts.
      for (const wait of [750, 1_500, 3_000, 0]) {
        h.wire.next().fail(new ReadError("unavailable", "Bad gateway", 502));
        await vi.advanceTimersByTimeAsync(wait);
      }
      await rejected;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.query).toHaveBeenCalledTimes(4);
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe("endpoint profile search under session ownership", () => {
  it.each(["revoke", "disconnect", "cache"] as const)(
    "cancels a pending search on %s and drops a late result",
    async (boundary) => {
      const h = setup("endpoint");
      try {
        const pending = h.owner.session.searchProfiles("Person", {
          limit: 40,
          signal: new AbortController().signal,
        });
        const result = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const request = h.wire.next();
        expect(h.searchProfiles).toHaveBeenCalledTimes(1);
        if (boundary === "revoke") h.revoke();
        else if (boundary === "cache") await h.owner.clearCache();
        else h.live.state({ status: "connecting", routes: [] });
        request.respond([profile(h.person, { name: "Person" })]);
        expect(await result).toMatchObject({ error: { name: "AbortError" } });
        expect(request.signal?.aborted).toBe(true);
      } finally {
        h.owner.dispose();
      }
    },
  );
  it("times out a search the relay never answers", async () => {
    vi.useFakeTimers();
    const h = setup("endpoint");
    try {
      const pending = h.owner.session.searchProfiles("Person", {
        limit: 40,
        signal: new AbortController().signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        kind: "unavailable",
        message: "Relay read timed out",
      });
      const request = h.wire.next();
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(request.signal?.aborted).toBe(true);
    } finally {
      h.owner.dispose();
      vi.useRealTimers();
    }
  });
});
