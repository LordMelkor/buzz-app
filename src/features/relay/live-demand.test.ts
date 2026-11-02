import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { followUpQueue } from "../messages/follow-up-queue";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  signed,
  scriptedTransport,
} from "./testing";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const interests = vi.fn();
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update: interests, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  const connected = () =>
    live.state({
      status: "connected",
      routes: [
        { id: "profiles", status: "live", replay: "unknown" },
        { id: "membership", status: "live", replay: "unknown" },
      ],
    });
  return {
    relay,
    viewer,
    wire,
    owner,
    interests,
    get live() {
      return live;
    },
    connected,
  };
}
it("live retry recovers roster catch-up refused after globals established", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    expect(first.filters[0]?.kinds).toEqual([39002]);
    first.fail(
      new ReadError("unavailable", "Relay requests paused", 429, 60000),
    );
    await flush();
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "error",
      channels: [],
    });
    expect(h.owner.session.live.snapshot().roster).toEqual({
      state: "error",
      error: "Relay requests paused",
      transient: true,
    });
    h.owner.session.live.retry();
    h.owner.session.channels.refreshList?.();
    h.owner.session.channels.ensureList();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.channels.list().status).toBe("ready");
    expect(h.owner.session.live.snapshot().roster).toEqual({
      state: "verified",
    });
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});
it("current-channel post-subscribe read keeps a foreground slot when another background read is stalled", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    const background = h.owner.session
      .read([{ kinds: [0], authors: [h.viewer.pubkey], limit: 1 }], {
        priority: "background",
      })
      .catch(() => []);
    const stalled = h.wire.next();
    h.connected();
    h.live.established("a");
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    expect(h.wire.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
    stalled.respond([]);
    await background;
  } finally {
    h.owner.dispose();
  }
});
it("post-subscribe verification means the fetched gap message actually reaches the retained window", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    h.connected();
    h.live.established("a");
    await flush();
    const gap = message(h.viewer, "a", "arrived in gap", 1700000001);
    h.wire
      .next()
      .respond([
        gap,
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
    expect(
      h.owner.session.channels.window("a").rows.map((row) => row.id),
    ).toContain(gap.id);
    for (const request of h.wire.pending.splice(0)) request.respond([]);
    await flush();
  } finally {
    h.owner.dispose();
  }
});
it("Refresh messages during known catch-up cooldown preserves the lightweight obligation", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    h.connected();
    h.live.established("a");
    await flush();
    h.wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    h.owner.session.channels.refresh?.("a");
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.channels.refresh?.("a");
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it("coalesces hints during a busy roster without letting retry clicks create work", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    expect(first.filters[0]).not.toHaveProperty("consistency");
    h.owner.session.live.retry();
    h.owner.session.live.retry();
    first.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    h.owner.session.channels.refreshList?.();
    const second = h.wire.next();
    const hint = signed(h.relay, {
      kind: 44100,
      content: "",
      tags: [["p", h.viewer.pubkey]],
    });
    h.live.receive([hint]);
    h.live.receive([hint]);
    await flush();
    second.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const confirmation = h.wire.next();
    expect(confirmation.filters[0]?.consistency).toBe("strong");
    confirmation.respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

async function readyRoster(h: ReturnType<typeof setup>) {
  h.connected();
  h.live.established();
  await flush();
  h.wire.next().respond([]);
  await flush();
  expect(h.owner.session.channels.list().status).toBe("ready");
  expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  expect(h.wire.pending).toHaveLength(0);
}
function membershipHint(
  h: ReturnType<typeof setup>,
  id: string,
  kind = 44100,
  extra: string[][] = [],
) {
  return signed(h.relay, {
    kind,
    content: "",
    tags: [["p", h.viewer.pubkey], ["h", id], ...extra],
  });
}
function exactFilters(h: ReturnType<typeof setup>, ids: string[]) {
  return [
    {
      kinds: [39000],
      consistency: "strong",
      authors: [h.relay.pubkey],
      "#d": [...ids].sort(),
      limit: ids.length + 1,
    },
    {
      kinds: [39002],
      consistency: "strong",
      authors: [h.relay.pubkey],
      "#d": [...ids].sort(),
      "#p": [h.viewer.pubkey],
      limit: ids.length + 1,
    },
  ];
}

// A retired hint must survive to deliberate recovery, without making ordinary
// refreshes writer-backed once that obligation has been fulfilled.
async function recoverRetiredHint(h: ReturnType<typeof setup>) {
  expect(h.wire.pending).toHaveLength(1);
  const recovery = h.wire.next();
  expect(recovery.filters[0]?.kinds).toEqual([39002]);
  expect(recovery.filters[0]?.["#d"]).toBeUndefined();
  expect(recovery.filters[0]?.consistency).toBe("strong");
  recovery.respond(
    recovery.filters[0]?.consistency === "strong"
      ? [
          metadata(h.relay, "a", "Alpha"),
          roster(h.relay, "a", [h.viewer.pubkey]),
        ]
      : [],
  );
  await flush();
  expect(h.owner.session.channels.list()).toMatchObject({
    status: "ready",
    channels: [{ id: "a", name: "Alpha" }],
  });
  expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  expect(h.wire.pending).toHaveLength(0);
  h.owner.session.channels.refreshList?.();
  const ordinary = h.wire.next();
  expect(ordinary.filters[0]).not.toHaveProperty("consistency");
  ordinary.respond([]);
  await flush();
  expect(h.wire.pending).toHaveLength(0);
}

it("a named member-added hint confirms only that channel and preserves verified roster state", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    const changes: string[] = [];
    h.owner.session.live.subscribe(() => {
      changes.push(h.owner.session.live.snapshot().roster.state);
    });
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const exact = h.wire.next();
    expect(exact.filters).toEqual(exactFilters(h, ["a"]));
    exact.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "a", name: "Alpha" }],
    });
    expect(h.owner.session.channels.get?.("a")?.readOnly).toBeUndefined();
    expect(h.interests).toHaveBeenLastCalledWith(["a"], ["a"]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(changes).not.toContain("pending");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

// NIP-CL: a system channel's notices are 44100/44101 with ["t","system"].
it("a system channel member-added hint admits that channel without listing it", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([membershipHint(h, "records", 44100, [["t", "system"]])]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const exact = h.wire.next();
    expect(exact.filters).toEqual(exactFilters(h, ["records"]));
    exact.respond([
      metadata(h.relay, "records", "Records", undefined, [
        ["private"],
        ["hidden"],
        ["t", "system"],
      ]),
      signed(h.relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", "records"],
          ["t", "system"],
          ["p", h.viewer.pubkey],
        ],
      }),
    ]);
    await flush();
    await flush();
    expect(h.owner.session.channels.get?.("records")).toMatchObject({
      id: "records",
      channelType: "system",
      members: [h.viewer.pubkey],
    });
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [],
    });
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("a system channel member-removed hint keeps the full roster refresh", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([membershipHint(h, "records", 44101, [["t", "system"]])]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const full = h.wire.next();
    expect(full.filters[0]?.kinds).toEqual([39002]);
    expect(full.filters[0]?.["#d"]).toBeUndefined();
    expect(full.filters[0]?.consistency).toBe("strong");
    full.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each(["removal", "held", "empty", "ambiguous"])(
  "a %s membership hint keeps the full roster refresh",
  async (scenario) => {
    const h = setup();
    try {
      await readyRoster(h);
      if (scenario === "held")
        h.live.receive([
          metadata(h.relay, "a", "Alpha"),
          roster(h.relay, "a", [h.viewer.pubkey]),
        ]);
      const hint =
        scenario === "ambiguous"
          ? signed(h.relay, {
              kind: 44100,
              content: "",
              tags: [
                ["p", h.viewer.pubkey],
                ["h", "a"],
                ["h", "b"],
              ],
            })
          : membershipHint(
              h,
              scenario === "empty" ? "" : "a",
              scenario === "removal" ? 44101 : 44100,
            );
      h.live.receive([hint]);
      await flush();
      await flush();
      expect(h.wire.pending).toHaveLength(1);
      const full = h.wire.next();
      expect(full.filters).toEqual([
        {
          kinds: [39002],
          consistency: "strong",
          "#p": [h.viewer.pubkey],
          limit: 500,
        },
      ]);
      full.respond([]);
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it("a named hint during initial discovery queues a full pass without prematurely readying the list", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const initial = h.wire.next();
    expect(h.owner.session.channels.list().status).toBe("loading");
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    await flush();
    expect(h.owner.session.channels.list().status).toBe("loading");
    expect(h.wire.pending).toHaveLength(0);
    initial.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const followup = h.wire.next();
    expect(followup.filters[0]?.kinds).toEqual([39002]);
    expect(followup.filters[0]?.["#d"]).toBeUndefined();
    expect(followup.filters[0]?.consistency).toBe("strong");
    followup.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
    ]);
    await flush();
    expect(h.owner.session.channels.list().channels).toMatchObject([
      { id: "a", name: "Alpha" },
    ]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each(["failed", "empty", "nonmember"])(
  "a %s exact membership confirmation falls back to a full pass",
  async (outcome) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      if (outcome === "failed")
        exact.fail(new ReadError("unavailable", "Read failed"));
      else
        exact.respond(
          outcome === "empty"
            ? []
            : [metadata(h.relay, "a", "Alpha", undefined, [["public"]])],
        );
      await flush();
      await flush();
      expect(h.wire.pending).toHaveLength(1);
      const full = h.wire.next();
      expect(full.filters[0]?.kinds).toEqual([39002]);
      expect(full.filters[0]?.["#d"]).toBeUndefined();
      expect(full.filters[0]?.consistency).toBe("strong");
      full.respond([
        metadata(h.relay, "a", "Alpha", 1700000001),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ]);
      await flush();
      expect(h.owner.session.channels.get?.("a")).toMatchObject({
        id: "a",
        name: "Alpha",
      });
      expect(h.owner.session.channels.get?.("a")?.readOnly).toBeUndefined();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([
  { mixed: false, path: "one exact read" },
  { mixed: true, path: "only a full pass when a removal is mixed in" },
])("member-added hints in one delivery use $path", async ({ mixed }) => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([
      membershipHint(h, "a"),
      membershipHint(h, "b"),
      membershipHint(h, "a"),
      ...(mixed ? [membershipHint(h, "c", 44101)] : []),
    ]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const read = h.wire.next();
    if (mixed) {
      expect(read.filters[0]?.kinds).toEqual([39002]);
      expect(read.filters[0]?.["#d"]).toBeUndefined();
      expect(read.filters[0]?.consistency).toBe("strong");
    } else expect(read.filters).toEqual(exactFilters(h, ["a", "b"]));
    read.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
      metadata(h.relay, "b", "Beta"),
      roster(h.relay, "b", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    expect(
      h.owner.session.channels
        .list()
        .channels.map((c) => c.name)
        .sort(),
    ).toEqual(["Alpha", "Beta"]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each(["preview", "denied"])(
  "a named hint confirms fresh membership for a %s channel",
  async (state) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.live.receive([
        metadata(h.relay, "a", "Alpha", undefined, [["public"]]),
      ]);
      if (state === "denied")
        h.live.denied("a", "restricted: not a channel member");
      expect(h.owner.session.channels.get?.("a")?.readOnly).toBe(
        state === "preview" ? true : undefined,
      );
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      exact.respond([
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ]);
      await flush();
      await flush();
      expect(h.owner.session.channels.get?.("a")).toMatchObject({
        id: "a",
        name: "Alpha",
      });
      expect(h.owner.session.channels.get?.("a")?.readOnly).toBeUndefined();
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it("membership hint batches respect the exact-read channel cap", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    const ids = Array.from({ length: 129 }, (_, index) => `channel-${index}`);
    h.live.receive(ids.map((id) => membershipHint(h, id)));
    await flush();
    expect(h.wire.pending).toHaveLength(2);
    for (const batch of [ids.slice(0, 128), ids.slice(128)]) {
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, batch));
      exact.respond(
        batch.flatMap((id) => [
          metadata(h.relay, id, id),
          roster(h.relay, id, [h.viewer.pubkey]),
        ]),
      );
    }
    await flush();
    await flush();
    expect(h.owner.session.channels.list().channels).toHaveLength(129);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("membership hints from another signer or for another viewer do not read discovery", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([
      signed(h.viewer, {
        kind: 44100,
        content: "",
        tags: [
          ["p", h.viewer.pubkey],
          ["h", "a"],
        ],
      }),
      signed(h.relay, {
        kind: 44100,
        content: "",
        tags: [
          ["p", h.relay.pubkey],
          ["h", "a"],
        ],
      }),
    ]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  { reset: "cache-clear", inFlight: false },
  { reset: "cache-clear", inFlight: true },
  { reset: "disconnect", inFlight: false },
  { reset: "disconnect", inFlight: true },
])(
  "$reset retires a hint (in flight: $inFlight) but preserves writer routing for deliberate recovery",
  async ({ reset, inFlight }) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.live.receive([membershipHint(h, "a")]);
      if (inFlight) await flush();
      const exact = inFlight ? h.wire.next() : undefined;
      if (exact) expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      if (reset === "cache-clear") await h.owner.clearCache();
      else h.live.state({ status: "retrying", routes: [] });
      if (exact) {
        expect(exact.signal?.aborted).toBe(true);
        exact.respond([
          metadata(h.relay, "a", "Alpha"),
          roster(h.relay, "a", [h.viewer.pubkey]),
        ]);
      }
      await flush();
      await flush();
      // Retirement must neither admit a delayed grant nor start a recovery pass.
      expect(h.wire.pending).toHaveLength(0);
      expect(h.owner.session.channels.get?.("a")).toBeUndefined();
      expect(h.owner.session.channels.list().status).toBe("ready");
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      if (reset === "disconnect") {
        h.connected();
        h.live.established();
      } else h.owner.session.channels.refreshList?.();
      await flush();
      await recoverRetiredHint(h);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["cache-clear", "disconnect"])(
  "%s during a replica pass retains a later hint without automatically rerunning the interrupted pass",
  async (reset) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.owner.session.channels.refreshList?.();
      const full = h.wire.next();
      expect(full.filters[0]).not.toHaveProperty("consistency");
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      if (reset === "cache-clear") await h.owner.clearCache();
      else h.live.state({ status: "retrying", routes: [] });
      expect(exact.signal?.aborted).toBe(true);
      expect(full.signal?.aborted).toBe(true);
      exact.respond([
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ]);
      full.respond([]);
      await flush();
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("deferred");
      expect(h.owner.session.channels.get?.("a")).toBeUndefined();
      expect(h.wire.pending).toHaveLength(0);
      if (reset === "disconnect") {
        h.connected();
        h.live.established();
      } else h.owner.session.live.retry();
      await flush();
      await recoverRetiredHint(h);
    } finally {
      h.owner.dispose();
    }
  },
);

it("an exact membership confirmation cannot overwrite a concurrent roster error", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.owner.session.channels.refreshList?.();
    const full = h.wire.next();
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    const exact = h.wire.next();
    expect(exact.filters).toEqual(exactFilters(h, ["a"]));
    full.fail(new ReadError("unavailable", "Roster paused", 429, 60000));
    await flush();
    expect(h.owner.session.channels.list().status).toBe("error");
    exact.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    expect(exact.signal?.aborted).toBe(true);
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "error",
      error: "Roster paused",
      channels: [],
    });
    expect(h.owner.session.live.snapshot().roster.state).toBe("error");
    expect(h.wire.pending).toHaveLength(0);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    expect(h.owner.session.channels.list().status).toBe("error");
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.live.retry();
    await flush();
    await recoverRetiredHint(h);
  } finally {
    h.owner.dispose();
  }
});

it("a concurrent roster failure without a cooldown retires the exact confirmation and keeps the error for Retry", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.owner.session.channels.refreshList?.();
    const full = h.wire.next();
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    const exact = h.wire.next();
    expect(exact.filters).toEqual(exactFilters(h, ["a"]));
    full.fail(new ReadError("unavailable", "Roster failed", 503));
    await flush();
    await flush();
    expect(exact.signal?.aborted).toBe(true);
    exact.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    // The intentional abort is not a failed lookup: no fallback full pass
    // replaces the error, which stays visible and retryable.
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "error",
      error: "Roster failed",
      channels: [],
    });
    expect(h.owner.session.live.snapshot().roster).toEqual({
      state: "error",
      error: "Roster failed",
      transient: true,
    });
    expect(h.wire.pending).toHaveLength(0);
    h.owner.session.live.retry();
    await flush();
    await recoverRetiredHint(h);
  } finally {
    h.owner.dispose();
  }
});

it("singleton member-added deliveries coalesce into one exact read and never duplicate an in-flight confirmation", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([
      metadata(h.relay, "x", "Xray"),
      roster(h.relay, "x", [h.viewer.pubkey]),
    ]);
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    // Shipped transports deliver one event per receive() call.
    for (const id of ["a", "b", "a"]) h.live.receive([membershipHint(h, id)]);
    h.owner.session.channels.ensure("x");
    await flush();
    // One exact read for both channels leaves the reader's foreground slots to
    // the conversation read instead of queueing it behind three hint reads.
    const requests = h.wire.pending.splice(0);
    expect(requests).toHaveLength(2);
    const exact = requests.find((r) => r.filters[0]?.kinds?.[0] === 39000);
    const head = requests.find((r) => r.filters[0]?.["#h"]?.includes("x"));
    expect(exact?.filters).toEqual(exactFilters(h, ["a", "b"]));
    expect(head).toBeDefined();
    // A repeated hint while its confirmation is in flight reads nothing more.
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    head?.respond([
      bounds(h.relay, "x", "head", { has_more: false, next_cursor: null }),
    ]);
    exact?.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
      metadata(h.relay, "b", "Beta"),
      roster(h.relay, "b", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    expect(
      h.owner.session.channels
        .list()
        .channels.map((c) => c.name)
        .sort(),
    ).toEqual(["Alpha", "Beta", "Xray"]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  "the full refresh completes first",
  "the delayed grant is released first",
])(
  "a later removal hint supersedes a pending grant confirmation when %s",
  async (order) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      h.live.receive([membershipHint(h, "b", 44101)]);
      await flush();
      const full = h.wire.next();
      expect(full.filters[0]?.kinds).toEqual([39002]);
      expect(full.filters[0]?.["#d"]).toBeUndefined();
      // The full pass started after the exact read, so its complete roster is
      // the newer authority; the older confirmation is retired before it lands.
      expect(exact.signal?.aborted).toBe(true);
      const grant = [
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ];
      if (order === "the full refresh completes first") {
        full.respond([]);
        await flush();
        exact.respond(grant);
      } else {
        exact.respond(grant);
        await flush();
        expect(h.owner.session.channels.get?.("a")).toBeUndefined();
        full.respond([]);
      }
      await flush();
      await flush();
      expect(h.owner.session.channels.list()).toMatchObject({
        status: "ready",
        channels: [],
      });
      expect(h.owner.session.channels.get?.("a")).toBeUndefined();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([false, true])(
  "a direct full refresh (strong: %s) inherits an in-flight hint's writer requirement",
  async (strong) => {
    const h = setup();
    try {
      await readyRoster(h);
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      h.owner.session.channels.refreshList?.(
        strong ? { consistency: "strong" } : {},
      );
      const full = h.wire.next();
      expect(full.filters[0]?.consistency).toBe(strong ? "strong" : undefined);
      expect(exact.signal?.aborted).toBe(true);
      await flush();
      expect(h.wire.pending).toHaveLength(0);
      const grant = [
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ];
      full.respond(strong ? grant : []);
      await flush();
      if (!strong) {
        const confirmation = h.wire.next();
        expect(confirmation.filters[0]?.consistency).toBe("strong");
        confirmation.respond(grant);
        await flush();
      }
      exact.respond(grant);
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["a"],
      );
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
      h.owner.session.channels.refreshList?.();
      const ordinary = h.wire.next();
      expect(ordinary.filters[0]).not.toHaveProperty("consistency");
      ordinary.respond(grant);
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["interrupted", "failed"])(
  "a superseding full pass that is %s keeps the grant it inherited from a retired confirmation",
  async (outcome) => {
    const h = setup();
    try {
      h.connected();
      h.live.established();
      await flush();
      h.wire
        .next()
        .respond([
          metadata(h.relay, "b", "Beta"),
          roster(h.relay, "b", [h.viewer.pubkey]),
        ]);
      await flush();
      expect(h.owner.session.channels.list()).toMatchObject({
        status: "ready",
        channels: [{ id: "b", name: "Beta" }],
      });
      expect(h.wire.pending).toHaveLength(0);
      h.live.receive([membershipHint(h, "a")]);
      await flush();
      const exact = h.wire.next();
      expect(exact.filters).toEqual(exactFilters(h, ["a"]));
      h.live.receive([membershipHint(h, "b", 44101)]);
      await flush();
      const full = h.wire.next();
      expect(full.filters[0]?.kinds).toEqual([39002]);
      expect(full.filters[0]?.["#d"]).toBeUndefined();
      expect(full.filters[0]?.consistency).toBe("strong");
      expect(exact.signal?.aborted).toBe(true);
      const grant = [
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ];
      if (outcome === "interrupted") {
        // B's route closes as a non-member while the pass runs. The denial
        // revokes B and invalidates the pass, which settles nothing and ends
        // deferred; the grant it inherited from A's retired confirmation must
        // not wait for Retry, another hint or a reconnect.
        h.live.denied("b", "restricted: not a channel member");
        await flush();
        await flush();
        expect(full.signal?.aborted).toBe(true);
        expect(h.owner.session.channels.get?.("b")).toBeUndefined();
        expect(h.wire.pending).toHaveLength(1);
        const rerun = h.wire.next();
        expect(rerun.filters[0]?.kinds).toEqual([39002]);
        expect(rerun.filters[0]?.["#d"]).toBeUndefined();
        expect(rerun.filters[0]?.consistency).toBe("strong");
        rerun.respond(grant);
        await flush();
      } else {
        full.fail(new ReadError("unavailable", "Roster failed", 503));
        await flush();
        await flush();
        // A failed pass keeps its error for deliberate Retry, as before.
        expect(h.owner.session.live.snapshot().roster).toEqual({
          state: "error",
          error: "Roster failed",
          transient: true,
        });
        expect(h.wire.pending).toHaveLength(0);
        h.owner.session.live.retry();
        await flush();
        expect(h.wire.pending).toHaveLength(1);
        const retry = h.wire.next();
        expect(retry.filters[0]?.consistency).toBe("strong");
        retry.respond(grant);
        await flush();
      }
      expect(h.owner.session.channels.list()).toMatchObject({
        status: "ready",
        channels: [{ id: "a", name: "Alpha" }],
      });
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it("a removal hint after a completed grant confirmation still revokes the channel", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    h.wire
      .next()
      .respond([
        metadata(h.relay, "a", "Alpha"),
        roster(h.relay, "a", [h.viewer.pubkey]),
      ]);
    await flush();
    await flush();
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "a", name: "Alpha" }],
    });
    expect(h.wire.pending).toHaveLength(0);
    h.live.receive([membershipHint(h, "a", 44101)]);
    await flush();
    const full = h.wire.next();
    expect(full.filters[0]?.kinds).toEqual([39002]);
    expect(full.filters[0]?.["#d"]).toBeUndefined();
    expect(full.filters[0]?.consistency).toBe("strong");
    full.respond([]);
    await flush();
    await flush();
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [],
    });
    expect(h.owner.session.channels.get?.("a")).toBeUndefined();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("disposing an exact membership confirmation aborts the read and prevents its fallback", async () => {
  const h = setup();
  try {
    await readyRoster(h);
    h.live.receive([membershipHint(h, "a")]);
    await flush();
    const exact = h.wire.next();
    expect(exact.filters).toEqual(exactFilters(h, ["a"]));
    const changed = vi.fn();
    h.owner.session.live.subscribe(changed);
    h.owner.dispose();
    const snapshot = h.owner.session.live.snapshot();
    exact.respond([
      metadata(h.relay, "a", "Alpha"),
      roster(h.relay, "a", [h.viewer.pubkey]),
    ]);
    await flush();
    await flush();
    expect(exact.signal?.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(h.owner.session.live.snapshot()).toBe(snapshot);
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("queued membership hints and reconnect cannot bypass a learned roster pause", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    expect(first.filters[0]).not.toHaveProperty("consistency");
    h.live.receive([
      signed(h.relay, {
        kind: 44100,
        content: "",
        tags: [["p", h.viewer.pubkey]],
      }),
    ]);
    await flush();
    first.fail(new ReadError("unavailable", "Paused", 429, 60000));
    await flush();
    h.live.state({ status: "retrying", routes: [] });
    h.connected();
    h.live.established();
    await flush();
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    const confirmation = h.wire.next();
    expect(confirmation.filters[0]?.consistency).toBe("strong");
    confirmation.respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  { name: "rate-limited roster", retryAfterMs: 60_000, metadata: false },
  { name: "refused roster", retryAfterMs: undefined, metadata: false },
  { name: "rate-limited metadata", retryAfterMs: 60_000, metadata: true },
  { name: "refused metadata", retryAfterMs: undefined, metadata: true },
])(
  "a $name read keeps writer routing for explicit retry",
  async ({ retryAfterMs, metadata: failMetadata }) => {
    const h = setup();
    try {
      h.connected();
      h.live.established();
      await flush();
      h.wire.next().respond([]);
      await flush();
      h.live.receive([
        signed(h.relay, {
          kind: 44100,
          content: "",
          tags: [["p", h.viewer.pubkey]],
        }),
      ]);
      await flush();
      const membership = roster(h.relay, "new", [h.viewer.pubkey]);
      let refused = h.wire.next();
      expect(refused.filters[0]?.consistency).toBe("strong");
      if (failMetadata) {
        refused.respond([membership]);
        await flush();
        expect(
          h.owner.session.channels.list().channels.map((c) => c.id),
        ).toEqual(["new"]);
        refused = h.wire.next();
        expect(refused.filters[0]).toMatchObject({
          kinds: [39000],
          consistency: "strong",
        });
      }
      refused.fail(
        new ReadError(
          "unavailable",
          "Read refused",
          retryAfterMs === undefined ? undefined : 429,
          retryAfterMs,
        ),
      );
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("error");
      expect(h.wire.pending).toHaveLength(0);
      if (retryAfterMs !== undefined) {
        h.owner.session.live.retry();
        await flush();
        expect(h.wire.pending).toHaveLength(0);
        vi.spyOn(performance, "now").mockReturnValue(
          performance.now() + retryAfterMs + 1,
        );
      }
      h.owner.session.live.retry();
      await flush();
      const retry = h.wire.next();
      expect(retry.filters[0]?.consistency).toBe("strong");
      const granted = [membership, metadata(h.relay, "new", "New channel")];
      // Only the writer has the newly granted membership; no live roster echo.
      retry.respond(retry.filters[0]?.consistency === "strong" ? granted : []);
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["new"],
      );
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
      h.owner.session.channels.refreshList?.();
      await flush();
      const ordinary = h.wire.next();
      expect(ordinary.filters[0]).not.toHaveProperty("consistency");
      ordinary.respond(granted);
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([
  { interruption: "cache clear", stage: "roster" },
  { interruption: "cache clear", stage: "metadata" },
  { interruption: "revocation", stage: "roster" },
  { interruption: "revocation", stage: "metadata" },
])(
  "$interruption during a hinted $stage read preserves writer routing on retry",
  async ({ interruption, stage }) => {
    const h = setup();
    try {
      const existing = roster(h.relay, "old", [h.viewer.pubkey]);
      h.connected();
      h.live.established();
      await flush();
      h.wire.next().respond([existing, metadata(h.relay, "old", "Old")]);
      await flush();
      h.live.receive([
        signed(h.relay, {
          kind: 44100,
          content: "",
          tags: [["p", h.viewer.pubkey]],
        }),
      ]);
      await flush();
      const membership = roster(h.relay, "new", [h.viewer.pubkey]);
      let interrupted = h.wire.next();
      expect(interrupted.filters[0]?.consistency).toBe("strong");
      if (stage === "metadata") {
        interrupted.respond([existing, membership]);
        await flush();
        expect(h.owner.session.channels.get?.("new")).toBeDefined();
        interrupted = h.wire.next();
        expect(interrupted.filters[0]).toMatchObject({
          kinds: [39000],
          consistency: "strong",
        });
      }
      if (interruption === "cache clear") await h.owner.clearCache();
      else h.live.receive([roster(h.relay, "old", [], 1700000001)]);
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      interrupted.respond([roster(h.relay, "stale", [h.viewer.pubkey])]);
      await flush();
      expect(h.owner.session.channels.get?.("stale")).toBeUndefined();
      // Revocation owes a pass by itself; cache clear waits for a retry.
      if (interruption === "cache clear") {
        expect(h.owner.session.live.snapshot().roster.state).toBe("deferred");
        expect(h.wire.pending).toHaveLength(0);
        h.owner.session.live.retry();
        await flush();
      }
      const retry = h.wire.next();
      expect(retry.filters[0]?.consistency).toBe("strong");
      const granted = [membership, metadata(h.relay, "new", "New")];
      // Only the writer has this grant, and no second membership hint arrives.
      retry.respond(retry.filters[0]?.consistency === "strong" ? granted : []);
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["new"],
      );
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);
      h.owner.session.channels.refreshList?.();
      const ordinary = h.wire.next();
      expect(ordinary.filters[0]).not.toHaveProperty("consistency");
      ordinary.respond(granted);
      await flush();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["unavailable", "denied"] as const)(
  "a %s metadata read retains roster authority and remains recoverable",
  async (kind) => {
    const h = setup();
    try {
      h.live.receive([roster(h.relay, "old", [h.viewer.pubkey])]);
      h.connected();
      h.live.established();
      await flush();
      h.wire.next().respond([roster(h.relay, "a", [h.viewer.pubkey])]);
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["a"],
      );
      const names = h.wire.next();
      expect(names.filters[0]?.kinds).toEqual([39000]);
      names.fail(
        new ReadError(
          kind,
          "Names unavailable",
          kind === "denied" ? 403 : 429,
          60000,
        ),
      );
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["a"],
      );
      expect(h.owner.session.live.snapshot().roster.state).toBe("error");
      h.owner.session.live.retry();
      await flush();
      expect(h.wire.pending).toHaveLength(0);
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
      h.owner.session.live.retry();
      await flush();
      h.wire
        .next()
        .respond([
          roster(h.relay, "a", [h.viewer.pubkey]),
          metadata(h.relay, "a", "A"),
        ]);
      await flush();
      expect(h.owner.session.channels.list().status).toBe("ready");
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  },
);

it("denied roster revokes retained access; ordinary retry only regrants with fresh authority", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    const secret = message(h.viewer, "a", "private", 1700000001);
    h.wire
      .next()
      .respond([
        secret,
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    for (const request of h.wire.pending.splice(0)) request.respond([]);
    await flush();
    h.connected();
    h.live.established();
    await flush();
    h.wire.next().fail(new ReadError("denied", "Membership denied", 403));
    await flush();
    expect(h.owner.session.channels.list().channels).toEqual([]);
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("error");
    h.owner.session.live.retry();
    await flush();
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
    h.wire
      .next()
      .respond([
        roster(h.relay, "a", [h.viewer.pubkey], 1700000002),
        metadata(h.relay, "a", "A"),
      ]);
    await flush();
    expect(h.owner.session.channels.list().status).toBe("ready");
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
  } finally {
    h.owner.dispose();
  }
});

it("an interrupted roster cannot satisfy a new connection's establishment", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const stale = h.wire.next();
    h.live.state({ status: "retrying", routes: [] });
    h.connected();
    h.live.established();
    await flush();
    expect(stale.signal?.aborted).toBe(true);
    stale.respond([roster(h.relay, "stale", [h.viewer.pubkey])]);
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    expect(h.owner.session.live.snapshot().roster.state).toBe("pending");
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.channels.list().channels).toEqual([]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it.each(["roster", "metadata"])(
  "disposal fences late %s completions and retry",
  async (stage) => {
    const h = setup();
    h.connected();
    h.live.receive([membershipHint(h, "")]);
    await flush();
    let late = h.wire.next();
    expect(late.filters[0]?.consistency).toBe("strong");
    if (stage === "metadata") {
      late.respond([roster(h.relay, "a", [h.viewer.pubkey])]);
      await flush();
      late = h.wire.next();
    }
    const changed = vi.fn();
    h.owner.session.live.subscribe(changed);
    h.owner.dispose();
    const snapshot = h.owner.session.live.snapshot();
    late.respond([]);
    await flush();
    h.owner.session.live.retry();
    await flush();
    expect(late.signal?.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(h.owner.session.live.snapshot()).toBe(snapshot);
    expect(h.wire.pending).toHaveLength(0);
  },
);

it("cache-clear interrupts a roster without a newer hint: deferred, not falsely verified, and retryable", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const old = h.wire.next();
    await h.owner.clearCache();
    old.respond([roster(h.relay, "stale", [h.viewer.pubkey])]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("deferred");
    expect(h.owner.session.channels.list().channels).toEqual([]);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});
it("a ready unchanged list still publishes roster pending before the refresh read", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    const changed = vi.fn();
    h.owner.session.live.subscribe(changed);
    const list = h.owner.session.channels.list();
    h.owner.session.channels.refreshList?.();
    expect(h.owner.session.channels.list()).toBe(list);
    expect(h.owner.session.live.snapshot().roster.state).toBe("pending");
    expect(changed).toHaveBeenCalled();
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});
it("disposing from the pending-roster notification blocks subsequent list notifications and dispatch", async () => {
  const h = setup();
  let disposedList:
    | ReturnType<typeof h.owner.session.channels.list>
    | undefined;
  const listChanged = vi.fn();
  h.owner.session.channels.subscribeList(listChanged);
  h.owner.session.live.subscribe(() => {
    if (h.owner.session.live.snapshot().roster.state === "pending") {
      h.owner.dispose();
      disposedList = h.owner.session.channels.list();
    }
  });
  h.owner.session.channels.ensureList();
  await flush();
  expect(disposedList).toBeDefined();
  expect(h.owner.session.channels.list()).toBe(disposedList);
  expect(listChanged).not.toHaveBeenCalled();
  expect(h.wire.pending).toHaveLength(0);
});

it.each(["denied", "membership"])(
  "retires queued follow-ups after remote %s access loss",
  async (loss) => {
    const h = setup();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const publish = vi.fn(() => "queued-message");
    try {
      await readyRoster(h);
      h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
      const queue = followUpQueue(h.owner.session);
      queue.submit({
        channelId: "a",
        text: "pending",
        recipients: [],
        publish,
        beforeRelease: () => gate,
      });
      expect(queue.snapshot()).toHaveLength(1);
      if (loss === "denied") h.live.denied("a", "restricted: not a member");
      else h.live.receive([roster(h.relay, "a", [], 1700000001)]);
      expect(queue.snapshot()).toEqual([]);
      resume();
      await gate;
      expect(publish).not.toHaveBeenCalled();
    } finally {
      resume();
      h.owner.dispose();
    }
  },
);
