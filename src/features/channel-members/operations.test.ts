import { expect, it, vi } from "vitest";
import { createMemberAdditions } from "./operations";

it("coalesces reopened views and retries a failed addition", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(async () => {
      await gate;
      throw new Error("Could not add");
    })
    .mockResolvedValue(undefined);
  const owner = createMemberAdditions(new AbortController().signal, add);
  const first = owner.add("channel", "person");
  const retry = owner.add("channel", "person");
  expect(retry).toBe(first);
  const failed = expect(first).rejects.toThrow("Could not add");
  release();
  await failed;
  expect(owner.snapshot()[0]).toMatchObject({
    confirmed: false,
    pending: false,
    error: "Could not add",
  });
  await owner.add("channel", "person");
  expect(add).toHaveBeenCalledTimes(2);
  expect(owner.snapshot()).toEqual([]);
});

it("session disposal cancels the continuation and clears recovery state", async () => {
  const lifetime = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createMemberAdditions(lifetime.signal, () => gate);
  const operation = owner.add("channel", "person");
  await Promise.resolve();
  lifetime.abort();
  const cancelled = expect(operation).rejects.toThrow();
  release();
  await cancelled;
  expect(owner.snapshot()).toEqual([]);
  await expect(owner.add("channel", "person")).rejects.toThrow(
    "connection closed",
  );
});

it("passes a requested guest role to the addition, and only to that one", async () => {
  const roles: (string | undefined)[] = [];
  const owner = createMemberAdditions(
    new AbortController().signal,
    async (_channel, _person, intent) => {
      roles.push(intent.role);
    },
  );
  await owner.add("channel", "agent", { role: "guest" });
  await owner.add("other", "agent");
  expect(roles).toEqual(["guest", undefined]);
});

it("joins an addition under way only when it asks for the same role", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const roles: (string | undefined)[] = [];
  const add = vi.fn(
    async (_channel: string, _agent: string, intent: object) => {
      roles.push((intent as { role?: string }).role);
      await gate;
    },
  );
  const owner = createMemberAdditions(new AbortController().signal, add);
  const first = owner.add("channel", "agent");
  expect(owner.add("channel", "agent")).toBe(first);
  await expect(
    owner.add("channel", "agent", { role: "guest" }),
  ).rejects.toThrow(/another role/);
  release();
  await first;
  expect(add).toHaveBeenCalledOnce();
  expect(roles).toEqual([undefined]);
});
