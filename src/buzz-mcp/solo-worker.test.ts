import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import { respond } from "./rpc";
import { sessionTools } from "./session-tools";
import { callSoloWorkerTool, type Clock } from "./solo-worker";
import {
  ACK_HORIZON,
  type GrantAck,
  type Intent,
  intentId,
  readRecord,
  recordTemplate,
  type Response,
} from "./solo-worker-protocol";

const key = (byte: number) => new Uint8Array(32).fill(byte);
const OWNER = key(1);
const AGENT = key(2);
const WORKER = key(3);
const RELAY = key(4);
const STRANGER = key(5);
const H = getPublicKey(OWNER);
const C = getPublicKey(AGENT);
const W = getPublicKey(WORKER);
const K = "7d3c1b52-9a0e-4f61-8d2b-3c5e6f708192";
const S = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const START = 1_790_000_000;
/** How long discovery, and then each answer, may take. */
const WAIT_MS = 20_000;
const ROUTE = {
  v: 1,
  owner: H,
  controller: C,
  stream: K,
  community: "wss://relay.example.com",
  device: "desk-1",
  grant: { id: "g1", revision: 3 },
} as const;
const ACK: GrantAck = {
  ...ROUTE,
  type: "grant_ack",
  workers: [W],
  operations: [
    "archive",
    "create",
    "list",
    "read",
    "readiness",
    "send",
    "stop",
  ],
  state: "active",
  issued_at: START - 100,
};

type Answer = Readonly<
  Partial<Response> & { phase: Response["phase"]; signer?: Uint8Array }
>;
/** What the owner's Buzz answers each request with, in revision order. */
type Owner = (intent: Intent, id: string) => readonly Answer[];
const ready: Owner = (intent) =>
  intent.action === "readiness"
    ? [
        {
          phase: "ready",
          result: { custody_epoch: "c7", valid_until: intent.issued_at + 30 },
        },
      ]
    : [];

/** A community holding the agent's control channel with the owner, whose
 * Buzz answers requests as `owner` says. */
function community(
  owner: Owner = ready,
  options: {
    roster?: string[];
    ack?: GrantAck | null;
    visibility?: "private" | "public" | null;
    /** The agent's owner as its host records it; null where none is, as standalone. */
    recorded?: string | null;
  } = {},
) {
  let now = START;
  const clock: Clock = {
    now: () => now,
    wait: async (ms) => {
      now += ms / 1000;
    },
  };
  const events: BuzzEvent[] = [];
  const sign = (
    secret: Uint8Array,
    template: Template,
    at = Math.floor(now),
  ) => {
    const event = finalizeEvent(
      {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
        created_at: at,
      },
      secret,
    );
    events.push(event);
    return event;
  };
  sign(RELAY, {
    kind: 39002,
    content: "",
    tags: [
      ["d", K],
      ...(options.roster ?? [H, C]).map((member) => [
        "p",
        member,
        "",
        "member",
      ]),
    ],
  });
  if (options.visibility !== null)
    sign(RELAY, {
      kind: 39000,
      content: "",
      tags: [["d", K], [options.visibility ?? "private"]],
    });
  if (options.ack !== null) sign(OWNER, recordTemplate(options.ack ?? ACK));
  const published: BuzzEvent[] = [];
  const client: BuzzClient = {
    pubkey: C,
    key: C,
    ...(options.recorded === null ? {} : { owner: options.recorded ?? H }),
    relayAuthor: getPublicKey(RELAY),
    async query(filters: readonly Filter[]) {
      const [filter = {}] = filters as Record<string, unknown>[];
      const has = (
        name: string,
        values: (event: BuzzEvent) => readonly unknown[],
      ) => {
        const wanted = filter[name] as unknown[] | undefined;
        return (event: BuzzEvent) =>
          !wanted || values(event).some((value) => wanted.includes(value));
      };
      const tagged = (letter: string) => (event: BuzzEvent) =>
        event.tags.filter((tag) => tag[0] === letter).map((tag) => tag[1]);
      const checks = [
        has("kinds", (event) => [event.kind]),
        has("authors", (event) => [event.pubkey]),
        ...["h", "e", "p", "d"].map((letter) =>
          has(`#${letter}`, tagged(letter)),
        ),
      ];
      const until = filter.until as number | undefined;
      return events
        .filter((event) => checks.every((check) => check(event)))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .filter(
          (event) =>
            until === undefined ||
            event.created_at < until ||
            (event.created_at === until && event.id > String(filter.before_id)),
        )
        .slice(0, filter.limit as number);
    },
    async publish(template: Template) {
      const event = sign(AGENT, template);
      published.push(event);
      const intent = readRecord(event, "request");
      if (intent) {
        const id = await intentId(intent);
        for (const [index, { signer = OWNER, ...answer }] of owner(
          intent,
          id,
        ).entries())
          sign(
            signer,
            recordTemplate(
              {
                ...ROUTE,
                type: "response",
                request: id,
                action: intent.action,
                revision: index + 1,
                observed_at: Math.floor(now),
                ...answer,
              } as Response,
              [event.id],
            ),
          );
      }
      return event;
    },
  } as unknown as BuzzClient;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await callSoloWorkerTool(client, name, args, clock));
  const requests = () =>
    published.map((event) => readRecord(event, "request") as Intent);
  return {
    call,
    client,
    clock,
    requests,
    published,
    sign,
  };
}

describe("solo_worker_connections", () => {
  it("lists the owner's acknowledged grant", async () => {
    expect(await community().call("solo_worker_connections")).toEqual({
      connections: [
        {
          owner: H,
          stream: K,
          workers: [W],
          actions: ACK.operations,
          state: "active",
        },
      ],
      complete: true,
    });
  });

  it("ignores a channel with anyone else in it", async () => {
    const { call } = community(ready, { roster: [H, C, W] });
    expect((await call("solo_worker_connections")).connections).toEqual([]);
  });

  it("stops using a channel once someone joins, even for a saved retry", async () => {
    const harness = community((intent) =>
      intent.action === "send" ? [{ phase: "accepted" }] : ready(intent, ""),
    );
    const { call, sign, published, client } = harness;
    const first = await call("solo_worker_send", {
      solo: S,
      worker_epoch: 1,
      text: "go",
    });
    expect(first.retry).toBeDefined();
    const stale = await client.query([{ kinds: [39002], "#d": [K] }]);
    sign(RELAY, {
      kind: 39002,
      content: "",
      tags: [["d", K], ...[H, C, W].map((member) => ["p", member])],
    });
    // A replica that still has the two-member roster; only the writer is current.
    const current = client.query;
    harness.client.query = async (filters) => {
      const [filter] = filters as { kinds: number[]; consistency?: string }[];
      return filter?.kinds.includes(39002) && filter.consistency !== "strong"
        ? stale
        : current(filters);
    };
    const before = published.length;
    await expect(
      call("solo_worker_send", { retry: first.retry }),
    ).rejects.toThrow(/No owner has authorized you/);
    expect(published).toHaveLength(before);
  });

  it("ignores an acknowledgement the owner did not sign", async () => {
    const { call, sign } = community(ready, { ack: null });
    sign(AGENT, recordTemplate(ACK));
    sign(STRANGER, recordTemplate(ACK));
    expect((await call("solo_worker_connections")).connections).toEqual([]);
    await expect(call("solo_worker_readiness")).rejects.toThrow(
      /No owner has authorized you/,
    );
  });

  it("ignores a roster the relay did not sign", async () => {
    const { call, sign } = community(ready, { roster: [H, C, W] });
    sign(STRANGER, {
      kind: 39002,
      content: "",
      tags: [
        ["d", K],
        ["p", H],
        ["p", C],
      ],
    });
    expect((await call("solo_worker_connections")).connections).toEqual([]);
  });

  it.each([
    ["public", "public"],
    ["without visibility", null],
  ] as const)("ignores a channel that is %s", async (_, visibility) => {
    const { call } = community(ready, { visibility });
    expect((await call("solo_worker_connections")).connections).toEqual([]);
  });

  it("stops using a channel made public, even for a saved retry", async () => {
    const harness = community((intent) =>
      intent.action === "send" ? [{ phase: "accepted" }] : ready(intent, ""),
    );
    const { call, sign, published, client } = harness;
    const first = await call("solo_worker_send", {
      solo: S,
      worker_epoch: 1,
      text: "go",
    });
    expect(first.retry).toBeDefined();
    const stale = await client.query([{ kinds: [39000], "#d": [K] }]);
    sign(RELAY, { kind: 39000, content: "", tags: [["d", K], ["public"]] });
    // A replica that still has the private metadata; only the writer is current.
    const current = client.query;
    harness.client.query = async (filters) => {
      const [filter] = filters as { kinds: number[]; consistency?: string }[];
      return filter?.kinds.includes(39000) && filter.consistency !== "strong"
        ? stale
        : current(filters);
    };
    const before = published.length;
    await expect(
      call("solo_worker_send", { retry: first.retry }),
    ).rejects.toThrow(/No owner has authorized you/);
    expect(published).toHaveLength(before);
  });

  it("checks the channel again just before posting a saved retry", async () => {
    const harness = community((intent) =>
      intent.action === "send" ? [{ phase: "accepted" }] : ready(intent, ""),
    );
    const { call, sign, published, client } = harness;
    const first = await call("solo_worker_send", {
      solo: S,
      worker_epoch: 1,
      text: "go",
    });
    expect(first.retry).toBeDefined();
    // Made public after discovery checked it, while it reads the grant.
    const current = client.query;
    let changed = false;
    harness.client.query = async (filters) => {
      const [filter] = filters as Record<string, unknown>[];
      if (!changed && filter?.["#h"] && !filter["#e"]) {
        changed = true;
        sign(RELAY, { kind: 39000, content: "", tags: [["d", K], ["public"]] });
      }
      return current(filters);
    };
    const before = published.length;
    await expect(
      call("solo_worker_send", { retry: first.retry }),
    ).rejects.toThrow(/no longer private.*not sent/);
    expect(changed).toBe(true);
    expect(published).toHaveLength(before);
  });

  it.each([
    ["solo_worker_readiness", {}],
    ["solo_worker_read", { solo: S }],
    ["solo_worker_list", {}],
  ] as const)(
    "checks the channel again just before the first %s request",
    async (name, args) => {
      const harness = community();
      const { call, sign, requests, client } = harness;
      // Made public after discovery checked it, while it reads the grant.
      const current = client.query;
      let changed = false;
      harness.client.query = async (filters) => {
        const [filter] = filters as Record<string, unknown>[];
        if (!changed && filter?.["#h"] && !filter["#e"]) {
          changed = true;
          sign(RELAY, {
            kind: 39000,
            content: "",
            tags: [["d", K], ["public"]],
          });
        }
        return current(filters);
      };
      await expect(call(name, args)).rejects.toThrow(
        /no longer private.*not sent/,
      );
      expect(changed).toBe(true);
      expect(requests()).toEqual([]);
    },
  );

  it("reads a few candidate channels at a time", async () => {
    const harness = community();
    const { call, sign, client } = harness;
    for (let index = 0; index < 30; index++) {
      const stream = `other-${index}`;
      sign(RELAY, {
        kind: 39002,
        content: "",
        tags: [
          ["d", stream],
          ["p", getPublicKey(key(10 + index))],
          ["p", C],
        ],
      });
      sign(RELAY, {
        kind: 39000,
        content: "",
        tags: [["d", stream], ["private"]],
      });
    }
    const current = client.query;
    let reading = 0;
    let most = 0;
    harness.client.query = async (filters) => {
      const [filter] = filters as { kinds: number[] }[];
      if (filter?.kinds.includes(39002)) return current(filters);
      most = Math.max(most, ++reading);
      await new Promise((resolve) => setTimeout(resolve));
      reading--;
      return current(filters);
    };
    expect(await call("solo_worker_connections")).toMatchObject({
      connections: [{ owner: H, stream: K }],
      complete: true,
    });
    expect(most).toBe(8);
  });

  it.each([
    ["made public", { kind: 39000, tags: [["d", K], ["public"]] }],
    [
      "joined by someone else",
      {
        kind: 39002,
        tags: [["d", K], ...[H, C, W].map((member) => ["p", member])],
      },
    ],
  ])(
    "sends no change once the channel is %s while the owner gets ready",
    async (_, change) => {
      const harness = community((intent, id) => {
        // After discovery, while the owner's Buzz answers readiness.
        if (intent.action === "readiness")
          harness.sign(RELAY, { ...change, content: "" }, START + 1);
        return ready(intent, id);
      });
      await expect(
        harness.call("solo_worker_send", {
          solo: S,
          worker_epoch: 1,
          text: "go",
        }),
      ).rejects.toThrow(/no longer private.*not sent/);
      expect(harness.requests().map(({ action }) => action)).toEqual([
        "readiness",
      ]);
    },
  );

  it.each([
    ["roster", 39002],
    ["metadata", 39000],
    ["acknowledgement", 9],
  ])(
    "fails without posting when the %s read never finishes",
    async (_, kind) => {
      const { client, clock, published } = community();
      const stalled = {
        ...client,
        query(filters: readonly Filter[]) {
          if (!(filters[0] as { kinds: number[] }).kinds.includes(kind))
            return client.query(filters);
          void clock.wait(WAIT_MS);
          return new Promise<never>(() => {});
        },
      } as BuzzClient;
      await expect(
        callSoloWorkerTool(stalled, "solo_worker_readiness", {}, clock),
      ).rejects.toThrow(/took too long/);
      expect(published).toEqual([]);
    },
  );

  it("finds nothing where the relay's roster cannot be checked", async () => {
    const { client } = community();
    await expect(
      callSoloWorkerTool(
        { ...client, relayAuthor: undefined },
        "solo_worker_connections",
        {},
      ),
    ).rejects.toThrow(/cannot verify channel members/);
  });

  it("lists each owner's grant, and uses the agent's own owner's unless another is named", async () => {
    const { call, sign, requests } = community();
    const elsewhere = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const stranger = getPublicKey(STRANGER);
    sign(RELAY, {
      kind: 39002,
      content: "",
      tags: [
        ["d", elsewhere],
        ["p", stranger],
        ["p", C],
      ],
    });
    sign(RELAY, {
      kind: 39000,
      content: "",
      tags: [["d", elsewhere], ["private"]],
    });
    sign(
      STRANGER,
      recordTemplate({ ...ACK, owner: stranger, stream: elsewhere }),
    );
    const { connections } = await call("solo_worker_connections");
    expect(
      connections.map((found: { owner: string }) => found.owner).sort(),
    ).toEqual([H, stranger].sort());
    expect(await call("solo_worker_readiness")).toMatchObject({
      phase: "ready",
    });
    expect(requests()).toMatchObject([{ owner: H, stream: K }]);
  });

  it("never chooses another person's grant unless it is named", async () => {
    // Anyone may grant the agent their own workers; this grant is not from
    // the owner its host records, and would receive the agent's task text.
    const { call, requests } = community(ready, {
      recorded: getPublicKey(STRANGER),
    });
    await expect(
      call("solo_worker_send", { solo: S, worker_epoch: 1, text: "go" }),
    ).rejects.toThrow(/Your own owner has not authorized you/);
    expect(requests()).toEqual([]);
    expect(await call("solo_worker_readiness", { owner: H })).toMatchObject({
      phase: "ready",
    });
  });

  it("needs owner where the host records no owner", async () => {
    const { call, requests } = community(ready, { recorded: null });
    await expect(call("solo_worker_readiness")).rejects.toThrow(/Give owner/);
    expect(requests()).toEqual([]);
    expect(await call("solo_worker_readiness", { owner: H })).toMatchObject({
      phase: "ready",
    });
  });

  it("uses its own owner's grant when not every channel could be checked", async () => {
    const { call, sign } = community();
    for (let index = 0; index < 500; index++)
      sign(
        RELAY,
        {
          kind: 39002,
          content: "",
          tags: [
            ["d", `other-${index}`],
            ["p", C],
          ],
        },
        START - 1,
      );
    expect(await call("solo_worker_connections")).toMatchObject({
      connections: [{ owner: H }],
      complete: false,
    });
    expect(await call("solo_worker_readiness")).toMatchObject({
      phase: "ready",
    });
  });

  it("says only as far as it could find that its own owner has not authorized it", async () => {
    const { call, sign } = community(ready, {
      recorded: getPublicKey(STRANGER),
    });
    for (let index = 0; index < 500; index++)
      sign(
        RELAY,
        {
          kind: 39002,
          content: "",
          tags: [
            ["d", `other-${index}`],
            ["p", C],
          ],
        },
        START - 1,
      );
    await expect(call("solo_worker_readiness")).rejects.toThrow(
      /Your own owner has not authorized you, as far as could be found/,
    );
  });

  it("reads the acknowledgement from the owner's newest events alone", async () => {
    const { call, sign } = community();
    for (let index = 0; index < ACK_HORIZON; index++)
      sign(
        OWNER,
        { kind: 9, content: `${index}`, tags: [["h", K]] },
        START + 1,
      );
    expect((await call("solo_worker_connections")).connections).toEqual([]);
    sign(OWNER, recordTemplate(ACK), START + 2);
    expect((await call("solo_worker_connections")).connections).toHaveLength(1);
  });

  it("follows the newest acknowledgement, so a revoked grant stops working", async () => {
    const { call, sign } = community();
    sign(
      OWNER,
      recordTemplate({
        ...ACK,
        state: "revoked",
        grant: { id: "g1", revision: 4 },
      }),
      START + 1,
    );
    expect((await call("solo_worker_connections")).connections[0].state).toBe(
      "revoked",
    );
    await expect(call("solo_worker_readiness")).rejects.toThrow(
      /No owner has authorized you/,
    );
  });

  it("reads the newest acknowledgement from the relay's writer", async () => {
    const harness = community();
    const { call, sign, client } = harness;
    const stale = await client.query([{ kinds: [9], "#h": [K] }]);
    sign(
      OWNER,
      recordTemplate({
        ...ACK,
        state: "revoked",
        grant: { id: "g1", revision: 4 },
      }),
      START + 1,
    );
    // A replica that has not seen the revocation; only the writer is current.
    const current = client.query;
    harness.client.query = async (filters) => {
      const [filter] = filters as { kinds: number[]; consistency?: string }[];
      return filter?.kinds.includes(9) && filter.consistency !== "strong"
        ? stale
        : current(filters);
    };
    expect((await call("solo_worker_connections")).connections[0].state).toBe(
      "revoked",
    );
  });

  it("follows the highest revision when acknowledgements share a second", async () => {
    const harness = community();
    harness.sign(
      OWNER,
      recordTemplate({
        ...ACK,
        state: "revoked",
        grant: { id: "g1", revision: 4 },
      }),
      START,
    );
    // The relay lists the older revision first.
    const current = harness.client.query;
    harness.client.query = async (filters) =>
      [...(await current(filters))].sort(
        (a, b) =>
          (readRecord(a, "grant_ack")?.grant.revision ?? 0) -
          (readRecord(b, "grant_ack")?.grant.revision ?? 0),
      );
    expect(
      (await harness.call("solo_worker_connections")).connections[0].state,
    ).toBe("revoked");
  });
});

describe("a change", () => {
  it("asks for readiness, then sends the request under that custody epoch", async () => {
    const { call, requests } = community((intent) =>
      intent.action === "create"
        ? [
            { phase: "accepted" },
            { phase: "ready", result: { solo: S, worker: W, worker_epoch: 1 } },
          ]
        : ready(intent, ""),
    );
    expect(
      await call("solo_worker_create", { worker: W, title: "Fix it" }),
    ).toMatchObject({
      status: "answered",
      phase: "ready",
      result: { solo: S, worker: W, worker_epoch: 1 },
    });
    const [readiness, create] = requests();
    expect(readiness?.action).toBe("readiness");
    expect(create).toMatchObject({
      action: "create",
      custody_epoch: "c7",
      admit_before: START + 30,
      args: { worker: W, title: "Fix it" },
    });
  });

  it("issues the change on the owner's clock, so skew cannot cut its readiness short", async () => {
    // The owner's clock is 35 seconds behind the agent's.
    const behind = START - 35;
    const { call, requests } = community((intent) =>
      intent.action === "readiness"
        ? [
            {
              phase: "ready",
              observed_at: behind,
              result: { custody_epoch: "c7", valid_until: behind + 30 },
            },
          ]
        : [{ phase: "ready", result: { solo: S, worker: W, worker_epoch: 1 } }],
    );
    expect(
      await call("solo_worker_create", { worker: W, title: "Fix it" }),
    ).toMatchObject({ status: "answered", phase: "ready" });
    expect(requests()[1]).toMatchObject({
      action: "create",
      issued_at: behind,
      admit_before: behind + 30,
    });
  });

  it("keeps why readiness got no answer when it sends no change", async () => {
    const { call, requests } = community(() => []);
    const answer = await call("solo_worker_stop", { solo: S, worker_epoch: 1 });
    expect(answer).toMatchObject({ status: "pending" });
    expect(answer.note).toMatch(/may be closed.*change was not sent/);
    expect(requests().map((request) => request.action)).toEqual(["readiness"]);
  });

  it("sends nothing when the owner's Buzz is not ready", async () => {
    const { call, requests } = community((intent) =>
      intent.action === "readiness"
        ? [{ phase: "refused", reason: "approval_required" }]
        : [],
    );
    expect(
      await call("solo_worker_send", { solo: S, worker_epoch: 1, text: "go" }),
    ).toMatchObject({
      status: "answered",
      phase: "refused",
      reason: "approval_required",
    });
    expect(requests().map((intent) => intent.action)).toEqual(["readiness"]);
  });

  it("refuses a worker or action the owner did not allow, before asking", async () => {
    const { call, requests } = community(ready, {
      ack: { ...ACK, operations: ["read", "readiness"] },
    });
    await expect(
      call("solo_worker_create", { worker: getPublicKey(STRANGER) }),
    ).rejects.toThrow(/not allowed solo_worker_create/);
    await expect(
      call("solo_worker_stop", { solo: S, worker_epoch: 1 }),
    ).rejects.toThrow(/not allowed/);
    expect(requests()).toEqual([]);
  });

  it("names a missing worker before asking for readiness", async () => {
    const { call, requests } = community();
    await expect(call("solo_worker_create")).rejects.toThrow(
      /request\.args\.worker.*required/,
    );
    expect(requests()).toEqual([]);
  });

  it("returns a pending request to retry, and a retry sends it unchanged", async () => {
    let settle = false;
    const { call, requests, published } = community((intent) =>
      intent.action === "send"
        ? settle
          ? [{ phase: "running" }, { phase: "settled", result: {} }]
          : [{ phase: "accepted" }]
        : ready(intent, ""),
    );
    const first = await call("solo_worker_send", {
      solo: S,
      worker_epoch: 1,
      text: "go",
    });
    expect(first).toMatchObject({ status: "pending", phase: "accepted" });
    expect(first.retry).toEqual(requests()[1]);
    settle = true;
    expect(
      await call("solo_worker_send", { retry: first.retry }),
    ).toMatchObject({
      status: "answered",
      request: first.request,
      phase: "settled",
    });
    expect(published.at(-1)?.content).toBe(published[1]?.content);
    expect(
      requests().filter((intent) => intent.action === "readiness"),
    ).toHaveLength(1);
  });

  it("returns an unsent request to retry when posting fails", async () => {
    const harness = community();
    const { call } = harness;
    const original = harness.client.publish;
    let calls = 0;
    harness.client.publish = (template) =>
      ++calls === 2
        ? Promise.reject(new Error("socket closed"))
        : original(template);
    const answer = await call("solo_worker_archive", { solo: S });
    expect(answer).toMatchObject({
      status: "unsent",
      retry: { action: "archive", args: { solo: S } },
    });
    expect(answer.note).toMatch(/may still have arrived/);
  });

  it("keeps a sent request to retry when checking for its answer fails", async () => {
    const harness = community();
    const original = harness.client.query;
    harness.client.query = (filters) =>
      harness.published.length === 2
        ? Promise.reject(new Error("offline"))
        : original(filters);
    const answer = await harness.call("solo_worker_archive", { solo: S });
    expect(answer).toMatchObject({
      status: "pending",
      retry: { action: "archive", args: { solo: S } },
    });
    expect(answer.note).toMatch(/was sent and may have run/);
  });

  it("refuses a retry with other arguments, or for another tool or agent", async () => {
    const { call } = community();
    const retry = {
      ...ROUTE,
      type: "request",
      action: "stop",
      nonce: "0".repeat(32),
      issued_at: START,
      admit_before: START + 60,
      custody_epoch: "c7",
      args: { solo: S, worker_epoch: 1 },
    };
    await expect(call("solo_worker_stop", { retry, solo: S })).rejects.toThrow(
      /on its own/,
    );
    await expect(call("solo_worker_archive", { retry })).rejects.toThrow(
      /not a solo_worker_archive request/,
    );
    await expect(
      call("solo_worker_stop", {
        retry: { ...retry, controller: getPublicKey(STRANGER) },
      }),
    ).rejects.toThrow(/request of yours/);
    await expect(
      call("solo_worker_stop", { retry: { ...retry, args: { solo: S } } }),
    ).rejects.toThrow(/worker_epoch is required/);
  });
});

describe("answers", () => {
  const settled = {
    phase: "settled",
    result: { workers: [], complete: true },
  } as const;

  it("count only when the owner signs them for this exact request", async () => {
    const { call } = community((intent) =>
      intent.action === "list"
        ? [
            { ...settled, device: "desk-2" },
            { ...settled, grant: { id: "g1", revision: 4 } },
            { ...settled, signer: STRANGER },
            { ...settled, signer: AGENT },
          ]
        : [],
    );
    const answer = await call("solo_worker_list");
    expect(answer).toMatchObject({ status: "pending" });
    expect(answer.note).toMatch(/may be closed/);
    expect(answer.retry).toBeUndefined();
  });

  it("stop waiting after 20 seconds, counting the time spent asking", async () => {
    const { client, clock } = community(() => []);
    let asked = 0;
    const slow = {
      ...client,
      async query(filters: readonly Filter[]) {
        if ((filters[0] as Record<string, unknown>)["#e"]) {
          asked++;
          await clock.wait(5_000);
        }
        return client.query(filters);
      },
    } as BuzzClient;
    const start = clock.now();
    const answer = JSON.parse(
      await callSoloWorkerTool(slow, "solo_worker_list", {}, clock),
    );
    expect(answer).toMatchObject({ status: "pending" });
    expect(asked).toBe(4);
    expect(clock.now() - start).toBeLessThanOrEqual(23);
  });

  it("stop at the deadline even when posting never finishes", async () => {
    const { client, clock } = community();
    const stalled = {
      ...client,
      publish() {
        void clock.wait(WAIT_MS);
        return new Promise<never>(() => {});
      },
    } as BuzzClient;
    const answer = JSON.parse(
      await callSoloWorkerTool(stalled, "solo_worker_list", {}, clock),
    );
    expect(answer).toMatchObject({ status: "unsent" });
    expect(answer.note).toMatch(/did not finish in time/);
  });

  it("stop at the deadline even when checking for the answer never finishes", async () => {
    const { client, clock } = community(() => []);
    const stalled = {
      ...client,
      query(filters: readonly Filter[]) {
        if (!(filters[0] as Record<string, unknown>)["#e"])
          return client.query(filters);
        void clock.wait(WAIT_MS);
        return new Promise<never>(() => {});
      },
    } as BuzzClient;
    expect(
      JSON.parse(
        await callSoloWorkerTool(stalled, "solo_worker_list", {}, clock),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("report two different answers at one revision as uncertain", async () => {
    const { call } = community((intent) =>
      intent.action === "list"
        ? [
            { ...settled, revision: 1 },
            {
              phase: "settled",
              revision: 1,
              result: { workers: [], complete: false },
            },
          ]
        : [],
    );
    expect(await call("solo_worker_list")).toMatchObject({
      status: "answered",
      phase: "uncertain",
      reason: "conflict",
    });
  });
});

describe("solo_worker_read", () => {
  it("shows the Solo's messages from the worker and those the owner relayed", async () => {
    const harness = community((intent) => {
      if (intent.action !== "read") return [];
      const tags = [["h", S]];
      const worker = finalizeEvent(
        { kind: 9, content: "done", tags, created_at: START },
        WORKER,
      );
      const relayed = finalizeEvent(
        {
          kind: 9,
          content: "next",
          tags: [...tags, ["control", "solo_worker", "1", "relay"]],
          created_at: START + 1,
        },
        OWNER,
      );
      return [
        {
          phase: "running",
          result: {
            worker: W,
            state: "running",
            worker_epoch: 1,
            events: [relayed, worker],
            complete: true,
          },
        },
      ];
    });
    const answer = await harness.call("solo_worker_read", { solo: S });
    expect(answer.result.messages).toEqual([
      expect.objectContaining({ from: "worker", text: "done" }),
      expect.objectContaining({ from: "you", text: "next" }),
    ]);
    expect(harness.requests()[0]?.args).toEqual({ solo: S, limit: 20 });
  });
});

describe("registration", () => {
  it("lists every Solo worker tool on search, with write annotations", () => {
    const tools = sessionTools().filter((tool) =>
      tool.name.startsWith("solo_worker_"),
    );
    expect(tools.map((tool) => [tool.name, tool.load])).toEqual(
      [
        "connections",
        "readiness",
        "create",
        "send",
        "read",
        "stop",
        "archive",
        "list",
      ].map((name) => [`solo_worker_${name}`, "search"]),
    );
    const annotations = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (tool as unknown as { annotations: object }).annotations,
      ]),
    );
    expect(annotations.solo_worker_connections).toEqual({ readOnlyHint: true });
    // Reading a worker still posts a request in the control channel.
    expect(annotations.solo_worker_read).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotations.solo_worker_stop).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("answers a session's call", async () => {
    const { client } = community();
    const reply = (await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "solo_worker_connections", arguments: {} },
      },
    )) as { result: { content: { text: string }[] } };
    expect(
      JSON.parse(reply.result.content[0]?.text ?? "").connections,
    ).toHaveLength(1);
  });

  it("refuses arguments a tool does not list", async () => {
    await expect(
      community().call("solo_worker_read", { solo: S, channel: K }),
    ).rejects.toThrow(/channel cannot be used/);
  });
});
