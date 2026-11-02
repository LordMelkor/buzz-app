import { createHmac } from "node:crypto";
import { it, expect } from "vitest";
import {
  generateSecretKey,
  getPublicKey,
  nip44,
  finalizeEvent,
} from "nostr-tools";
import { decodeAgentMemory, memoryFilter } from "./agent-memory.mjs";
import {
  MEMORY_EVENT_LIMIT,
  MEMORY_WIRE_BYTES,
  memoryResponseText,
} from "../src/features/agents/memory.ts";
const owner = generateSecretKey(),
  agent = generateSecretKey(),
  foreign = generateSecretKey();
const viewer = getPublicKey(owner),
  author = getPublicKey(agent);
const signal = () => new AbortController().signal;
function event(
  body = { slug: "mem/test", value: "private text" },
  patch = {},
  key = agent,
  recipient = viewer,
) {
  const conversation = nip44.v2.utils.getConversationKey(key, recipient);
  const slug = typeof body === "string" ? "mem/test" : body.slug;
  return finalizeEvent(
    {
      kind: 30174,
      created_at: 10,
      tags: [
        ["p", recipient],
        [
          "d",
          createHmac("sha256", conversation)
            .update("agent-memory/v1/d-tag\0")
            .update(slug)
            .digest("hex"),
        ],
      ],
      content: nip44.v2.encrypt(
        typeof body === "string" ? body : JSON.stringify(body),
        conversation,
      ),
      ...patch,
    },
    key,
  );
}
const decode = (events, s = signal()) =>
  decodeAgentMemory(events, owner, viewer, author, s);
it("constructs only exact agent + authenticated owner filters; rejects self, malformed and extra scope", () => {
  expect(memoryFilter({ agent: author }, viewer)).toEqual([
    { kinds: [30174], authors: [author], "#p": [viewer], limit: 256 },
  ]);
  for (const body of [
    { agent: viewer },
    { agent: "bad" },
    { agent: author, owner: getPublicKey(foreign) },
    { agent: author, relay: "elsewhere" },
    null,
  ])
    expect(() => memoryFilter(body, viewer)).toThrow();
});
it("reads remote-owned core and memories without inventory; resolves heads, ties and tombstones", async () => {
  const core = event({ slug: "core", profile: "identity" });
  const first = event(),
    second = event({ slug: "mem/test", value: "tie" });
  const winner = [first, second].sort((a, b) => a.id.localeCompare(b.id))[0];
  const result = await decode([second, core, first]);
  expect(result.partial).toBe(false);
  expect(result.entries).toEqual([
    { slug: "core", body: "identity", eventId: core.id, createdAt: 10 },
    {
      slug: "mem/test",
      body: winner === first ? "private text" : "tie",
      eventId: winner.id,
      createdAt: 10,
    },
  ]);
  expect(
    (
      await decode([
        event({ slug: "mem/test", value: null }, { created_at: 11 }),
        first,
      ])
    ).entries,
  ).toEqual([]);
  expect(await decode([])).toEqual({ entries: [], partial: false });
});
it("rejects foreign/forged/scope/body evidence as partial, never a proven-empty listing", async () => {
  const valid = event();
  const cases = [
    { ...valid, sig: "0".repeat(128) },
    event(undefined, { kind: 9 }),
    event(undefined, {}, foreign),
    event(undefined, {}, agent, getPublicKey(foreign)),
    event(undefined, { tags: [...valid.tags, valid.tags[0]] }),
    event(undefined, { tags: [...valid.tags, valid.tags[1]] }),
    event(undefined, {
      tags: [
        ["p", viewer],
        ["d", "0".repeat(64)],
      ],
    }),
    event({ slug: "mem/Test", value: "bad" }),
    event({ slug: "mem/test", value: 12 }),
    event({ slug: "core", value: "wrong shape" }),
    event('{"slug":"mem/test","value":"first","value":"second"}'),
    event('{"slug":"mem/test","value":"text","unknown":{"x":1,"\\u0078":2}}'),
    event('{"slug":"mem/test","value":"text","unknown":[{"x":1,"x":2}]}'),
    event("not json"),
  ];
  const cached = event();
  cached.content = "tampered";
  cases.push(cached);
  for (const value of cases)
    expect(await decode([value])).toEqual({ entries: [], partial: true });
  await expect(
    decodeAgentMemory([valid], foreign, viewer, author, signal()),
  ).rejects.toThrow();
  await expect(
    decodeAgentMemory([valid], owner, viewer, viewer, signal()),
  ).rejects.toThrow();
  // Quotes/braces inside values and unknown unique fields do not affect parsing.
  expect(
    (
      await decode([
        event({
          slug: "mem/test",
          value: '"{}[]:,',
          unknown: [{ x: 1 }, { x: 2 }],
        }),
      ])
    ).partial,
  ).toBe(false);
});
it("enforces event, plaintext and streamed wire budgets and cancellation", async () => {
  const value = event();
  expect((await decode(Array(MEMORY_EVENT_LIMIT).fill(value))).partial).toBe(
    true,
  );
  await expect(
    decode(Array(MEMORY_EVENT_LIMIT + 1).fill(value)),
  ).rejects.toThrow("budget");
  const many = Array.from({ length: 18 }, (_, i) =>
    event({ slug: `mem/large-${i}`, value: "x".repeat(60000) }),
  );
  await expect(decode(many)).rejects.toThrow("budget");
  await expect(
    memoryResponseText(new Response("x".repeat(MEMORY_WIRE_BYTES + 1))),
  ).rejects.toThrow("budget");
  const controller = new AbortController();
  controller.abort();
  await expect(decode([value], controller.signal)).rejects.toThrow();
});

// Mutate authenticated plaintext bytes without passing through a UTF-8 encoder.
// ChaCha20 XOR preserves offsets; recompute the MAC with the NIP-44 HKDF expand.
function invalidUtf8(bytes) {
  const conversation = nip44.v2.utils.getConversationKey(agent, viewer);
  const text = `{"slug":"mem/test","value":"${"?".repeat(bytes.length)}"}`;
  const payload = Buffer.from(nip44.v2.encrypt(text, conversation), "base64");
  const nonce = payload.subarray(1, 33);
  let block = Buffer.alloc(0);
  const blocks = [];
  for (let i = 1; i <= 3; i++) {
    block = createHmac("sha256", conversation)
      .update(block)
      .update(nonce)
      .update(Buffer.from([i]))
      .digest();
    blocks.push(block);
  }
  const keys = Buffer.concat(blocks);
  const offset = 33 + 2 + text.indexOf("?");
  for (let i = 0; i < bytes.length; i++) payload[offset + i] ^= 0x3f ^ bytes[i];
  createHmac("sha256", keys.subarray(44, 76))
    .update(payload.subarray(1, -32))
    .digest()
    .copy(payload, payload.length - 32);
  return event(undefined, {
    created_at: 11,
    content: payload.toString("base64"),
  });
}
it("rejects lossy UTF-8 and unpaired JSON surrogates before head selection", async () => {
  const tomb = event({ slug: "mem/test", value: null });
  const malformed = [
    ...[[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]].map(
      invalidUtf8,
    ),
    ...[
      '{"slug":"mem/test","value":"\\ud800"}',
      '{"slug":"mem/test","value":"\\udc00"}',
      '{"slug":"mem/test","value":null,"unknown":["\\ud800"]}',
      '{"slug":"mem/test","value":null,"\\ud800":true}',
    ].map((body) => event(body, { created_at: 11 })),
  ];
  for (const invalid of malformed) {
    for (const records of [
      [tomb, invalid],
      [invalid, tomb],
    ]) {
      expect(await decode(records)).toEqual({
        entries: [],
        deleted: [{ slug: "mem/test", createdAt: tomb.created_at }],
        partial: true,
      });
    }
  }
  const core = event({ slug: "core", profile: "old" });
  const invalidCore = event(
    { slug: "core", profile: "\ud800" },
    { created_at: 11 },
  );
  const result = await decode([core, invalidCore]);
  expect(result.partial).toBe(true);
  expect(result.entries[0]?.eventId).toBe(core.id);
  for (const value of ["�", "😀", "文", "\ufeff", "\ud83d\ude00"]) {
    const valid = event({ slug: "mem/test", value }, { created_at: 11 });
    const result = await decode([tomb, valid]);
    expect(result.partial).toBe(false);
    expect(result.entries[0]?.body).toBe(value);
  }
});
