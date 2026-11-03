import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  createLocalAgentActivity,
  type LocalWork,
} from "../agents/local-activity";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createOutbox } from "../relay/outbox";
import { createAgentActivity } from "../agents/activity";
import { followUpQueue } from "./follow-up-queue";

type ActivityTyping = ReturnType<
  RelaySession["agentActivity"]["snapshot"]
>["typing"];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(extra: Partial<RelaySession> = {}) {
  const listeners = new Set<() => void>();
  let local: readonly LocalWork[] = [];
  let turns: ReturnType<RelaySession["agentActivity"]["snapshot"]>["turns"] =
    [];
  let typing: ActivityTyping = [];
  const deactivate = vi.fn();
  const session = {
    channels: { list: () => ({ channels: [{ id: "chat" }, { id: "other" }] }) },
    ...extra,
    agentActivity: {
      activate: () => deactivate,
      snapshot: () => ({ local, turns, typing, status: "listening" }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  return {
    queue,
    session,
    deactivate,
    work(messageId: string, state: LocalWork["state"], channelId = "chat") {
      local = [
        ...local.filter((row) => row.messageId !== messageId),
        {
          messageId,
          state,
          channelId,
          agent: "agent",
          scope: "scope",
          threadRootId: "",
          startedAt: 1,
        },
      ];
      for (const listener of listeners) listener();
    },
    remote(state: "working" | "unknown" | "ended") {
      turns = [
        {
          agent: "agent",
          channelId: "chat",
          turnId: "turn",
          timestamp: 1,
          state,
        },
      ];
      for (const listener of listeners) listener();
    },
    typing(value: ActivityTyping) {
      typing = value;
      for (const listener of listeners) listener();
    },
    loseEvidence() {
      local = [];
      turns = [];
      for (const listener of listeners) listener();
    },
    entry(text: string, channelId = "chat") {
      return {
        text,
        channelId,
        recipients: ["agent"],
        publish: vi.fn(() => text),
      };
    },
  };
}

it("sends idle messages immediately and holds rapid follow-ups through the start gap", () => {
  const h = fixture(),
    first = { ...h.entry("first"), beforeRelease: vi.fn(async () => {}) },
    second = h.entry("second"),
    third = h.entry("third");
  // Freshly validated idle sends never flash a queued row or revalidate.
  expect(h.queue.submit(first, true)).toBe("first");
  expect(first.beforeRelease).not.toHaveBeenCalled();
  expect(h.queue.snapshot()).toEqual([]);
  h.queue.submit(second);
  h.queue.submit(third);
  expect(second.publish).not.toHaveBeenCalled();
  h.work("first", "working");
  h.work("first", "done");
  expect(second.publish).toHaveBeenCalledOnce();
  expect(third.publish).not.toHaveBeenCalled();
  h.work("second", "working");
  h.work("second", "done");
  expect(third.publish).toHaveBeenCalledOnce();
  expect(h.queue.snapshot()).toEqual([]);
});

it("waits for existing work, survives lost evidence, and permits Send now", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  h.loseEvidence();
  expect(entry.publish).not.toHaveBeenCalled();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.work("previous", "done");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("uses explicit remote completion, never a stale unknown state", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.remote("working");
  h.queue.submit(entry);
  h.remote("unknown");
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("retains failed sends for explicit retry without a retry loop", () => {
  const h = fixture(),
    entry = h.entry("next");
  entry.publish.mockImplementationOnce(() => {
    throw new Error("Unavailable recipient");
  });
  h.work("previous", "working");
  h.queue.submit(entry);
  h.work("previous", "done");
  expect(h.queue.snapshot()[0]?.error).toBe("Unavailable recipient");
  h.work("unrelated", "done", "other");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledTimes(2);
  expect(h.queue.snapshot()).toEqual([]);
});

it("isolates channels and sessions, and removal never publishes", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  expect(h.queue.submit(h.entry("elsewhere", "other"))).toBe("elsewhere");
  expect(followUpQueue(h.session)).toBe(h.queue);
  expect(fixture().queue.snapshot()).toEqual([]);
  h.queue.remove(h.queue.snapshot()[0]?.id ?? "missing");
  h.work("previous", "done");
  expect(entry.publish).not.toHaveBeenCalled();
});

it("does not publish a removed entry while release validation is pending", async () => {
  const h = fixture();
  h.work("previous", "working");
  let resume!: () => void;
  const entry = {
    ...h.entry("next"),
    beforeRelease: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  };
  h.queue.submit(entry);
  const id = h.queue.snapshot()[0]?.id ?? "missing";
  h.queue.sendNow(id);
  h.queue.remove(id);
  resume();
  await Promise.resolve();
  expect(entry.publish).not.toHaveBeenCalled();
  expect(h.queue.snapshot()).toEqual([]);
});

it("does not let settled local work mask a remote turn", () => {
  const h = fixture();
  h.work("old", "done");
  h.remote("working");
  const entry = h.entry("next");
  h.queue.submit(entry);
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("rechecks automatic blockers after validation but preserves explicit Send", async () => {
  const h = fixture();
  h.work("old", "working");
  const gate = deferred();
  const first = {
    ...h.entry("first"),
    beforeRelease: vi.fn(() => gate.promise),
  };
  h.queue.submit(first);
  h.work("old", "done");
  expect(first.beforeRelease).toHaveBeenCalledOnce();
  h.remote("working");
  gate.resolve();
  await gate.promise;
  expect(first.publish).not.toHaveBeenCalled();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  await Promise.resolve();
  expect(first.publish).toHaveBeenCalledOnce();
});

it("retains a second explicit Send while another entry validates", async () => {
  const h = fixture();
  h.work("old", "working");
  const gate = deferred();
  const first = { ...h.entry("first"), beforeRelease: () => gate.promise };
  const second = { ...h.entry("second"), beforeRelease: async () => {} };
  h.queue.submit(first);
  h.queue.submit(second);
  const [a, b] = h.queue.snapshot();
  h.queue.sendNow(a?.id ?? "missing");
  h.queue.sendNow(b?.id ?? "missing");
  await Promise.resolve();
  expect(second.publish).toHaveBeenCalledOnce();
  gate.resolve();
  await gate.promise;
  expect(first.publish).toHaveBeenCalledOnce();
});

it("validates the idle path and upgrades an automatic release to explicit Send", async () => {
  const h = fixture();
  const gate = deferred();
  const entry = {
    ...h.entry("next"),
    beforeRelease: vi.fn(() => gate.promise),
  };
  h.queue.submit(entry);
  expect(entry.beforeRelease).toHaveBeenCalledOnce();
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("working");
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  gate.resolve();
  await gate.promise;
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("activates the real observer before deciding and waits for its live snapshot", () => {
  const observe = vi.fn();
  const activity = createAgentActivity(true, observe, () => true);
  const session = {
    ...fixture().session,
    agentActivity: activity.queries,
  } as RelaySession;
  const queue = followUpQueue(session);
  const publish = vi.fn(() => "next");
  try {
    queue.submit({ channelId: "chat", text: "next", recipients: [], publish });
    expect(activity.queries.snapshot().status).toBe("connecting");
    expect(publish).not.toHaveBeenCalled();
    activity.receive(
      {
        id: "1".repeat(64),
        agent: "a".repeat(64),
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_started",
          turnId: "turn",
          channelId: "chat",
          timestamp: new Date().toISOString(),
        }),
      },
      observe.mock.lastCall?.[0],
    );
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    expect(publish).not.toHaveBeenCalled();
    activity.receive(
      {
        id: "2".repeat(64),
        agent: "a".repeat(64),
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_completed",
          turnId: "turn",
          channelId: "chat",
          timestamp: new Date().toISOString(),
        }),
      },
      observe.mock.lastCall?.[0],
    );
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    activity.dispose();
  }
});

it("only releases a failed Outbox wait after durable dismissal", async () => {
  const save = vi.fn(async () => {});
  const sign = vi.fn(async () => {
    throw new Error("Signing failed");
  });
  const owner = createOutbox(
    "a".repeat(64),
    { sign, publish: async () => {} },
    { load: () => [], save },
  );
  const h = fixture({ outbox: owner.outbox });
  try {
    await owner.ready;
    const first = {
      ...h.entry("first"),
      publish: () =>
        owner.outbox.send({ kind: 9, content: "first", tags: [["h", "chat"]] }),
    };
    const id = h.queue.submit(first) ?? "missing";
    await vi.waitFor(() =>
      expect(owner.outbox.snapshot()[0]?.delivery).toBe("failed"),
    );
    const next = h.entry("next");
    h.queue.submit(next);
    save.mockRejectedValueOnce(new Error("Disk full"));
    await expect(owner.outbox.dismiss(id)).rejects.toThrow("Disk full");
    expect(next.publish).not.toHaveBeenCalled();
    await owner.outbox.dismiss(id);
    expect(next.publish).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it.each(["unknown", "accepted"] as const)(
  "retains waits after dismissing %s delivery",
  async (delivery) => {
    const key = new Uint8Array(32).fill(7);
    const owner = createOutbox(
      getPublicKey(key),
      {
        sign: async (event) => finalizeEvent(structuredClone(event), key),
        publish: async () => {
          if (delivery === "unknown") throw new Error("Disconnected");
        },
      },
      { load: () => [], save: async () => {} },
    );
    const h = fixture({ outbox: owner.outbox });
    try {
      await owner.ready;
      const id =
        h.queue.submit({
          ...h.entry("first"),
          publish: () =>
            owner.outbox.send({
              kind: 9,
              content: "first",
              tags: [["h", "chat"]],
            }),
        }) ?? "missing";
      await vi.waitFor(() =>
        expect(owner.outbox.snapshot()[0]?.delivery).toBe(delivery),
      );
      const next = h.entry("next");
      h.queue.submit(next);
      await owner.outbox.dismiss(id);
      expect(next.publish).not.toHaveBeenCalled();
      h.work(id, "done");
      expect(next.publish).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  },
);

it("holds channel typing until it clears, without treating thread or other-channel typing as work", () => {
  const h = fixture();
  const typing = {
    agent: "agent",
    channelId: "chat",
    startedAt: 1,
    timestamp: 1,
    threadRootId: undefined,
    working: true,
    expiresAt: 8001,
  };
  h.typing([typing]);
  const entry = h.entry("next");
  h.queue.submit(entry);
  expect(entry.publish).not.toHaveBeenCalled();
  h.typing([
    { ...typing, threadRootId: "thread" },
    { ...typing, channelId: "other" },
  ]);
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("rejects a late upload submission after its destination disappeared without allocating a slot or activity lease", () => {
  const h = fixture({
    channels: { list: () => ({ channels: [] }) },
  } as unknown as Partial<RelaySession>);
  const activate = vi.spyOn(h.session.agentActivity, "activate");
  const entry = h.entry("late upload");
  expect(() => h.queue.submit(entry)).toThrow(
    "This chat is no longer available for sending.",
  );
  expect(h.queue.snapshot()).toEqual([]);
  expect(entry.publish).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

it("preserves an older unknown turn when an explicit overlapping send finishes first", () => {
  const h = fixture();
  h.remote("working");
  const first = h.entry("explicit");
  const next = h.entry("automatic");
  h.queue.submit(first);
  h.queue.submit(next);
  h.remote("unknown");
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(first.publish).toHaveBeenCalledOnce();
  h.work("explicit", "done");
  expect(next.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(next.publish).toHaveBeenCalledOnce();
});

it("observes independent owned-agent typing and releases on its updates", () => {
  let typing: { channelId: string; pubkey: string; threadRootId?: string }[] = [
    { channelId: "chat", pubkey: "agent" },
  ];
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const h = fixture({
    typing: {
      async send() {},
      snapshot: () => typing,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    } as RelaySession["typing"],
    agentChoices: {
      snapshot: () => ({ identities: [{ pubkey: "agent" }] }),
      subscribe: () => () => {},
    } as unknown as RelaySession["agentChoices"],
  });
  const entry = h.entry("next");
  h.queue.submit(entry);
  expect(entry.publish).not.toHaveBeenCalled();
  typing = [
    { channelId: "chat", pubkey: "human" },
    { channelId: "other", pubkey: "agent" },
    { channelId: "chat", pubkey: "agent", threadRootId: "thread" },
  ];
  for (const listener of listeners) listener();
  expect(entry.publish).toHaveBeenCalledOnce();
  h.work("next", "done");
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it.each(["missing", "read-only", "denied-error"])(
  "retires %s destinations on confirmed roster updates, including pending validation",
  async (loss) => {
    let roster = {
      status: "ready",
      channels: [
        { id: "chat", name: "Chat" },
        { id: "other", name: "Other" },
      ],
    } as ReturnType<RelaySession["channels"]["list"]>;
    let changed = () => {};
    const off = vi.fn();
    const h = fixture({
      channels: {
        list: () => roster,
        subscribeList: (listener: () => void) => {
          changed = listener;
          return off;
        },
      } as unknown as RelaySession["channels"],
    });
    h.remote("working");
    const gate = deferred();
    const entry = { ...h.entry("next"), beforeRelease: () => gate.promise };
    h.queue.submit(entry);
    h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
    roster = { ...roster, status: "error" };
    changed();
    expect(h.queue.snapshot()).toHaveLength(1);
    roster = {
      status: "ready",
      channels: [{ id: "chat", name: "Chat", readOnly: true, cached: true }],
    } as typeof roster;
    changed();
    expect(h.queue.snapshot()).toHaveLength(1);
    roster = {
      status: "ready",
      channels:
        loss !== "read-only"
          ? []
          : [{ id: "chat", name: "Chat", readOnly: true }],
    } as typeof roster;
    if (loss === "denied-error") roster = { ...roster, status: "error" };
    changed();
    expect(h.queue.snapshot()).toEqual([]);
    expect(h.deactivate).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    gate.resolve();
    await gate.promise;
    expect(entry.publish).not.toHaveBeenCalled();
  },
);

it("retires stopped local waits after independent work clears and ignores late completion", async () => {
  const h = fixture();
  const owner = createLocalAgentActivity();
  const off = owner.reader.subscribeWork(() => {
    for (const row of owner.reader.work()) h.work(row.messageId, row.state);
  });
  try {
    h.queue.submit(h.entry("first"));
    const work = owner.begin({
      scope: "scope",
      agent: "agent",
      channelId: "chat",
      messageId: "first",
      threadRootId: "",
    });
    work.step("Read");
    work.interruptible(async () => {});
    h.remote("working");
    h.typing([
      {
        agent: "agent",
        channelId: "chat",
        threadRootId: undefined,
        startedAt: 1,
        working: true,
      },
    ]);
    const next = h.entry("next");
    h.queue.submit(next);
    expect(next.publish).not.toHaveBeenCalled();
    await owner.reader.interrupt?.({
      scope: "scope",
      agent: "agent",
      messageId: "first",
    });
    work.finish({ ok: true });
    expect(owner.reader.work()[0]?.state).toBe("stopped");
    expect(next.publish).not.toHaveBeenCalled();
    h.remote("ended");
    expect(next.publish).not.toHaveBeenCalled();
    h.typing([]);
    expect(next.publish).toHaveBeenCalledOnce();
    h.work("next", "done");
    await vi.waitFor(() => expect(h.deactivate).toHaveBeenCalledOnce());
    expect(h.queue.snapshot()).toEqual([]);
  } finally {
    off();
  }
});

it("rejects late upload admission to confirmed read-only destinations before activation", () => {
  const h = fixture({
    channels: { list: () => ({ channels: [{ id: "chat", readOnly: true }] }) },
  } as unknown as Partial<RelaySession>);
  const activate = vi.spyOn(h.session.agentActivity, "activate");
  const entry = h.entry("late upload");
  expect(() => h.queue.submit(entry)).toThrow(
    "This chat is no longer available for sending.",
  );
  expect(entry.publish).not.toHaveBeenCalled();
  expect(h.queue.snapshot()).toEqual([]);
  expect(activate).not.toHaveBeenCalled();
});

it("keeps cached read-only destinations pending fresh release validation", async () => {
  const h = fixture({
    channels: {
      list: () => ({
        channels: [{ id: "chat", readOnly: true, cached: true }],
      }),
    },
  } as unknown as Partial<RelaySession>);
  const validation = deferred();
  const entry = {
    ...h.entry("cached"),
    beforeRelease: () => validation.promise,
  };
  try {
    expect(h.queue.submit(entry)).toBeUndefined();
    expect(h.queue.snapshot()).toHaveLength(1);
    expect(entry.publish).not.toHaveBeenCalled();
    const queued = h.queue.snapshot()[0];
    if (queued) h.queue.remove(queued.id);
  } finally {
    validation.resolve();
  }
  await vi.waitFor(() => expect(h.deactivate).toHaveBeenCalledOnce());
  expect(entry.publish).not.toHaveBeenCalled();
});
