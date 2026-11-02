import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { createCommunities } from "./service";
import { importLegacyCommunities } from "./legacy-communities";
import { flush } from "../relay/testing";

it("imports once and only after consent", async () => {
  const viewer = "a".repeat(64);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const root = new Context();
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  let answer!: (approved: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const confirm = vi.fn(() => pending);
  const read = vi.fn(async () => [
    { relayUrl: "wss://old.example", pubkey: viewer },
  ]);
  const dispose = importLegacyCommunities(communities, confirm, read);
  try {
    await flush();
    expect(confirm).toHaveBeenCalledWith(["https://old.example"]);
    expect(communities.snapshot().memberships).toEqual([]);
    expect(storage.size).toBe(0);
    answer(true);
    await flush();
    expect(communities.snapshot().memberships).toEqual([
      { id: "https://old.example", name: "old.example" },
    ]);
    expect(communities.snapshot().sync.outbox).toEqual([
      { url: "wss://old.example", removed: false },
    ]);
    expect(storage.get(`buzz-legacy-communities.v1:${viewer}`)).toBe("1");
    dispose();
    importLegacyCommunities(communities, confirm, read)();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    answer(false);
    await root.fiber.dispose();
    vi.unstubAllGlobals();
  }
});
