import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { AgentConfigStore } from "./agent-config";
import {
  artifactD,
  artifactTemplate,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { createConfigWriter, type WriteSide } from "./config-writes";
import { memoryStorage } from "./test-fakes";

const key = generateSecretKey();
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const type = "buzz.agent.instructions" as const;

/** A relay holding one artifact: a revision whose `prev` isn't the head is a
 * conflict, as NIP-AR requires. */
async function setup(
  options: { online?: () => boolean; publish?: () => Promise<void> } = {},
) {
  const d = await artifactD(type, channel);
  const side: WriteSide = {
    subject: { owner: "o", community: "c", subject: "a", channel, type },
    expected: { channel, type, d },
    title: "Agent instructions",
  };
  const relay = { head: undefined as RelayEvent | undefined, sent: 0 };
  const read: SnapshotRead = async () => (relay.head ? [relay.head] : []);
  const store = new AgentConfigStore(memoryStorage());
  const writer = createConfigWriter({
    read,
    store,
    maxEventBytes: 512 * 1024,
    signal: new AbortController().signal,
    online: options.online ?? (() => true),
    writer: {
      sign: async (template: EventTemplate) =>
        finalizeEvent(template, key) as RelayEvent,
      publish: async (event: RelayEvent) => {
        relay.sent += 1;
        await options.publish?.();
        const prev = event.tags.find(([name]) => name === "prev")?.[1];
        if (prev !== relay.head?.id)
          throw new PublishRejected("conflict", "conflict: stale prev");
        relay.head = event;
      },
    },
  });
  const save = (text: string, base: string | null) =>
    writer.save(side, { version: 1, text }, base);
  return { relay, store, side, save, writer };
}

describe("online config writes", () => {
  it("saves a revision on the opened head and installs it", async () => {
    const f = await setup();
    const first = await f.save("one", null);
    expect(first).toMatchObject({ status: "saved" });
    const second = await f.save("two", f.relay.head?.id ?? null);
    expect(second).toMatchObject({ status: "saved", head: f.relay.head });
    expect(f.store.state(f.side.subject).head?.id).toBe(f.relay.head?.id);
    expect(f.store.hadVersion(f.side.subject)).toBe(true);
  });

  it("refuses offline before reading or sending, and when the connection drops before dispatch", async () => {
    const offline = await setup({ online: () => false });
    expect(await offline.save("x", null)).toMatchObject({
      status: "refused",
      refusal: "offline",
    });
    expect(offline.relay.sent).toBe(0);
    let checks = 0;
    const dropping = await setup({ online: () => ++checks < 3 });
    expect(await dropping.save("x", null)).toMatchObject({
      refusal: "offline",
    });
    expect(dropping.relay.sent).toBe(0);
  });

  it("conflicts on a stale base without sending, and keeps the current head", async () => {
    const f = await setup();
    await f.save("one", null);
    const opened = f.relay.head?.id ?? null;
    await f.save("elsewhere", opened);
    const sent = f.relay.sent;
    const stale = await f.save("mine", opened);
    expect(stale).toMatchObject({ status: "conflict", head: f.relay.head });
    expect(f.relay.sent).toBe(sent);
    // An editor that opened nothing never overwrites a head it didn't see.
    expect(await f.save("mine", null)).toMatchObject({ status: "conflict" });
  });

  it("refuses when an opened head can't be read, rather than creating over it", async () => {
    const f = await setup();
    expect(await f.save("x", "missing")).toMatchObject({
      status: "refused",
      refusal: "unknown",
    });
    expect(f.relay.sent).toBe(0);
  });

  it("reports a send with no answer as unknown, once, with no resend", async () => {
    const f = await setup({
      publish: () => Promise.reject(new Error("timed out")),
    });
    expect(await f.save("x", null)).toEqual({
      status: "unknown",
      message: "timed out",
    });
    expect(f.relay.sent).toBe(1);
  });

  it("passes on a definite refusal", async () => {
    const f = await setup({
      publish: () =>
        Promise.reject(new PublishRejected("no", "restricted: not a member")),
    });
    expect(await f.save("x", null)).toMatchObject({
      status: "refused",
      refusal: "permission",
    });
  });

  it("serializes a Save and a History revert on one side: the later one conflicts unsent", async () => {
    const f = await setup();
    await f.save("one", null);
    const opened = f.relay.head;
    if (!opened) throw new Error("no head");
    const revert = artifactTemplate({
      ...f.side.expected,
      title: f.side.title,
      op: "update",
      prev: opened.id,
      content: opened.content,
    });
    const sent = f.relay.sent;
    const [saved, reverted] = await Promise.all([
      f.save("two", opened.id),
      f.writer.revise(f.side, revert, opened.id),
    ]);
    expect(saved).toMatchObject({ status: "saved" });
    expect(reverted).toMatchObject({ status: "conflict", head: f.relay.head });
    expect(f.relay.sent).toBe(sent + 1);
    expect(JSON.parse(f.relay.head?.content ?? "{}").text).toBe("two");
  });
});
