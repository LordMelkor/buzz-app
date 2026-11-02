import { finalizeEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import type { Template } from "./client";
import {
  admissible,
  answers,
  canonical,
  checkGrantAck,
  checkIntent,
  checkResponse,
  intentId,
  latest,
  parseCanonical,
  readRecord,
  recordTemplate,
  type Intent,
  type Response,
} from "./solo-worker-protocol";
import vectors from "./solo-worker-vectors.json";

const secret = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const OWNER = secret(vectors.keys.owner_secret);
const CONTROLLER = secret(vectors.keys.controller_secret);
const WORKER = secret(vectors.keys.worker_secret);
const request = (name: string) => {
  const found = vectors.requests.find((entry) => entry.name === name);
  if (!found) throw new Error(name);
  return found;
};
const response = (name: string) =>
  vectors.responses.find((entry) => entry.name === name)?.record as Response;
const signed = (key: Uint8Array, template: Template) =>
  finalizeEvent(
    {
      ...template,
      tags: template.tags.map((tag) => [...tag]),
      created_at: 1_790_000_000,
    },
    key,
  );
const CHECK = {
  request: checkIntent,
  response: checkResponse,
  grant_ack: checkGrantAck,
};

describe("Solo worker protocol vectors", () => {
  it.each(vectors.requests)("encodes and ids request $name", async (entry) => {
    const intent = checkIntent(entry.record);
    expect(canonical(intent)).toBe(entry.canonical);
    expect(parseCanonical(entry.canonical)).toEqual(entry.record);
    expect(await intentId(intent)).toBe(entry.id);
  });

  it.each([...vectors.responses, ...vectors.grant_acks])(
    "encodes $name",
    (entry) => {
      const check =
        entry.record.type === "response" ? checkResponse : checkGrantAck;
      expect(canonical(check(entry.record))).toBe(entry.canonical);
    },
  );

  it.each(vectors.refused)("refuses $kind: $name", (entry) => {
    const { text } = entry as { text?: string };
    if (text !== undefined) expect(() => parseCanonical(text)).toThrow();
    else
      expect(() =>
        CHECK[entry.kind as keyof typeof CHECK](entry.record),
      ).toThrow();
  });

  it("gives every distinct intent its own id", async () => {
    const ids = await Promise.all(
      vectors.requests.map((entry) => intentId(entry.record as Intent)),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("canonical", () => {
  it("sorts keys by UTF-16 code units and keeps text exact", () => {
    expect(canonical({ é: 1, z: 2, Z: 3, "😀": 4, "\u{ff5e}": 5 })).toBe(
      '{"Z":3,"z":2,"é":1,"😀":4,"～":5}',
    );
    expect(canonical(["line\nbreak", 'quote"'])).toBe(
      '["line\\nbreak","quote\\""]',
    );
  });

  it.each([null, undefined, 1.5, -1, 2 ** 53, "\uD800", new Date(0)])(
    "has no form for %s",
    (value) => expect(() => canonical({ value })).toThrow(),
  );
});

describe("admission", () => {
  const intent = request("create").record as Intent;

  it("admits from 30 seconds before issue until the deadline", () => {
    expect(admissible(intent, intent.issued_at - 31)).toBe(false);
    expect(admissible(intent, intent.issued_at - 30)).toBe(true);
    expect(admissible(intent, intent.admit_before - 1)).toBe(true);
    expect(admissible(intent, intent.admit_before)).toBe(false);
  });
});

describe("records as events", () => {
  const intent = request("send").record as Intent;

  it("reads back a request only from its controller in its channel", () => {
    const template = recordTemplate(intent);
    expect(template.tags).toEqual([
      ["h", intent.stream],
      ["control", "solo_worker", "1", "request"],
    ]);
    expect(readRecord(signed(CONTROLLER, template), "request")).toEqual(intent);
    expect(readRecord(signed(OWNER, template), "request")).toBeUndefined();
    expect(
      readRecord(signed(CONTROLLER, template), "response"),
    ).toBeUndefined();
    const elsewhere = {
      ...template,
      tags: [
        ["h", "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d"],
        ["control", "solo_worker", "1", "request"],
      ],
    };
    expect(
      readRecord(signed(CONTROLLER, elsewhere), "request"),
    ).toBeUndefined();
    const spaced = { ...template, content: JSON.stringify(intent, null, 1) };
    expect(readRecord(signed(CONTROLLER, spaced), "request")).toBeUndefined();
    const forged = { ...signed(CONTROLLER, template), sig: "0".repeat(128) };
    expect(readRecord(forged, "request")).toBeUndefined();
  });

  it("reads a response only from the owner, naming the requests it answers", () => {
    const record = response("send settled");
    const template = recordTemplate(record, ["a".repeat(64)]);
    expect(template.tags).toContainEqual(["e", "a".repeat(64)]);
    expect(readRecord(signed(OWNER, template), "response")).toEqual(record);
    expect(
      readRecord(signed(CONTROLLER, template), "response"),
    ).toBeUndefined();
  });

  it("reads a grant acknowledgement only from the owner", () => {
    const template = recordTemplate(
      vectors.grant_acks[0]?.record as Parameters<typeof recordTemplate>[0],
    );
    expect(readRecord(signed(OWNER, template), "grant_ack")).toBeDefined();
    expect(
      readRecord(signed(CONTROLLER, template), "grant_ack"),
    ).toBeUndefined();
  });
});

describe("answers", () => {
  const send = request("send");
  const intent = send.record as Intent;

  it("matches only the same request, action and route", () => {
    const record = response("send settled");
    expect(answers(record, intent, send.id)).toBe(true);
    expect(answers(record, intent, request("stop").id)).toBe(false);
    for (const change of [
      { device: "desk-2" },
      { community: "wss://other.example.com" },
      { grant: { id: "g1", revision: 4 } },
      { action: "stop" as const },
    ])
      expect(answers({ ...record, ...change }, intent, send.id)).toBe(false);
  });

  describe("a read's messages", () => {
    const read = request("read");
    const readIntent = read.record as Intent;
    const solo = readIntent.args.solo as string;
    const base = response("read running");
    const withEvents = (...events: ReturnType<typeof signed>[]) =>
      checkResponse({ ...base, result: { ...base.result, events } });

    it("come from the worker, or the owner relaying, in that Solo", () => {
      const fromWorker = signed(WORKER, {
        kind: 9,
        content: "done",
        tags: [["h", solo]],
      });
      const relayed = signed(OWNER, {
        kind: 9,
        content: "next",
        tags: [
          ["h", solo],
          ["control", "solo_worker", "1", "relay"],
        ],
      });
      expect(
        answers(withEvents(fromWorker, relayed), readIntent, read.id),
      ).toBe(true);
    });

    it.each([
      ["the owner without the relay mark", OWNER, [["h", "SOLO"]], 9],
      ["the controller", CONTROLLER, [["h", "SOLO"]], 9],
      [
        "another chat",
        WORKER,
        [["h", "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d"]],
        9,
      ],
      [
        "two chats at once",
        WORKER,
        [
          ["h", "SOLO"],
          ["h", "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d"],
        ],
        9,
      ],
      ["a reaction", WORKER, [["h", "SOLO"]], 7],
    ])("never from %s", (_name, key, tags, kind) => {
      const event = signed(key, {
        kind,
        content: "x",
        tags: tags.map((tag) =>
          tag.map((part) => (part === "SOLO" ? solo : part)),
        ),
      });
      expect(answers(withEvents(event), readIntent, read.id)).toBe(false);
    });

    it("must be validly signed", () => {
      const event = signed(WORKER, {
        kind: 9,
        content: "x",
        tags: [["h", solo]],
      });
      expect(() => withEvents({ ...event, content: "changed" })).toThrow(
        /validly signed/,
      );
    });
  });
});

describe("latest", () => {
  it("takes the highest revision and flags two different answers at it", () => {
    const accepted = response("create accepted");
    const ready = response("create ready");
    expect(latest([ready, accepted])).toBe(ready);
    expect(latest([accepted, ready, { ...ready }])).toBe(ready);
    const { result: _, ...bare } = ready;
    const refused: Response = { ...bare, phase: "refused", reason: "conflict" };
    expect(latest([ready, refused])).toBe("conflict");
    expect(latest([ready, refused, { ...ready, revision: 3 }])).toEqual({
      ...ready,
      revision: 3,
    });
    expect(latest([])).toBeUndefined();
  });
});
