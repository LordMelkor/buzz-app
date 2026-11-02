import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { pulseTyping } from "./typing";

const root = "b".repeat(64);
const mention = {
  id: "c".repeat(64),
  pubkey: "d".repeat(64),
  kind: 9,
  created_at: 1,
  content: "@Agent hi",
  tags: [
    ["h", "channel"],
    ["e", root, "", "reply"],
  ],
} as unknown as RelayEvent;

afterEach(() => vi.useRealTimers());
const threaded = () => Promise.resolve(false);

it("pulses in the mention's thread every three seconds until stopped", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  const stop = pulseTyping(publish, threaded(), mention, "channel", new Map());
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith({
    kind: 20002,
    content: "",
    tags: [
      ["h", "channel"],
      ["e", root, "", "root"],
      ["e", mention.id, "", "reply"],
    ],
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(publish).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).toHaveBeenCalledTimes(2);
});

it("tags a top-level mention as its own thread's root", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  const stop = pulseTyping(
    publish,
    threaded(),
    { ...mention, tags: [["h", "channel"]] },
    "channel",
    new Map(),
  );
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(publish.mock.calls[0]).toEqual([
    {
      kind: 20002,
      content: "",
      tags: [
        ["h", "channel"],
        ["e", mention.id, "", "reply"],
      ],
    },
  ]);
});

it("waits for a slow pulse, rides out a failure, and stops after three in a row", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let answer!: (ok: boolean) => void;
  const publish = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        answer = (ok) => (ok ? resolve() : reject(new Error("refused")));
      }),
  );
  pulseTyping(publish, threaded(), mention, "channel", new Map());
  await vi.advanceTimersByTimeAsync(6_000);
  expect(publish).toHaveBeenCalledOnce();
  // One failure, then a success, starts the count again.
  for (const ok of [false, true, false, false]) {
    answer(ok);
    await vi.advanceTimersByTimeAsync(3_000);
  }
  expect(publish).toHaveBeenCalledTimes(5);
  expect(warn).not.toHaveBeenCalled();
  answer(false);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).toHaveBeenCalledTimes(5);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

it("stops after half an hour of a run that never settles", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  pulseTyping(publish, threaded(), mention, "channel", new Map());
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  const sent = publish.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).toHaveBeenCalledTimes(sent);
  expect(vi.getTimerCount()).toBe(0);
});

it("types in the channel itself for a Solo chat, once its turn knows where it answers", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  let answer!: (topLevel: boolean) => void;
  const stop = pulseTyping(
    publish,
    new Promise<boolean>((resolve) => {
      answer = resolve;
    }),
    mention,
    "channel",
    new Map(),
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(publish).not.toHaveBeenCalled();
  answer(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith({
    kind: 20002,
    content: "",
    tags: [["h", "channel"]],
  });
  stop();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).toHaveBeenCalledOnce();
});

it("shows nothing for a turn that cannot tell where it answers, or that ended first", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  pulseTyping(
    publish,
    Promise.reject(new Error("Couldn't read your Solo chats")),
    mention,
    "channel",
    new Map(),
  );
  pulseTyping(publish, threaded(), mention, "channel", new Map())();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one pulse among turns in a thread, until the last of them stops", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => {});
  const pulses = new Map();
  const first = pulseTyping(publish, threaded(), mention, "channel", pulses);
  const second = pulseTyping(
    publish,
    threaded(),
    { ...mention, id: "e".repeat(64) },
    "channel",
    pulses,
  );
  const elsewhere = pulseTyping(
    publish,
    threaded(),
    { ...mention, tags: [["h", "channel"]] },
    "channel",
    pulses,
  );
  await vi.advanceTimersByTimeAsync(0);
  // One for the thread both turns are in, one for the other.
  expect(publish).toHaveBeenCalledTimes(2);
  elsewhere();
  first();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(publish).toHaveBeenCalledTimes(3);
  second();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(publish).toHaveBeenCalledTimes(3);
  expect(pulses.size).toBe(0);
});
