import { expect, it, vi } from "vitest";
import { migrateAgentStorage } from "./migrate-storage";
import { readRecords, readTeams, STORAGE_KEY, TEAMS_KEY } from "./store";
import { memoryStorage } from "./test-fakes";

it("moves settings and teams byte for byte, then restarts without resurrecting old data", async () => {
  const storage = memoryStorage();
  const pubkey = "a".repeat(64);
  const record = { pubkey, attention: {}, config: { draft: "kept" } };
  const team = {
    id: "one",
    name: "One",
    members: [pubkey],
    instructions: "hello",
  };
  const records = JSON.stringify({ version: 1, agents: { [pubkey]: record } });
  const teams = JSON.stringify({ version: 1, teams: [team] });
  storage.setItem("buzz.agents2.v1", records);
  storage.setItem("buzz.agents2.teams.v1", teams);
  await migrateAgentStorage(storage);
  expect(storage.getItem(STORAGE_KEY)).toBe(records);
  expect(storage.getItem(TEAMS_KEY)).toBe(teams);
  expect(readRecords(storage)[pubkey]).toMatchObject(record);
  expect(readTeams(storage)).toEqual([team]);
  expect(storage.getItem("buzz.agents2.v1")).toBeNull();
  expect(storage.getItem("buzz.agents2.teams.v1")).toBeNull();
  storage.setItem(STORAGE_KEY, "{}");
  await migrateAgentStorage(storage);
  expect(storage.getItem(STORAGE_KEY)).toBe("{}");
});

it("preserves the source on write failure and resumes an interrupted copy", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const storage = memoryStorage();
  storage.setItem("buzz.agents2.v1", "exact bytes");
  await migrateAgentStorage({
    ...storage,
    keys: storage.keys,
    get: storage.get,
    add: storage.add,
    set: async () => {
      throw new Error("full");
    },
  });
  expect(error).toHaveBeenCalledWith(
    "Cannot migrate buzz.agents2.v1",
    expect.objectContaining({ message: "full" }),
  );
  expect(storage.getItem("buzz.agents2.v1")).toBe("exact bytes");
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  error.mockRestore();
  storage.setItem(STORAGE_KEY, "exact bytes");
  await migrateAgentStorage(storage);
  expect(storage.getItem("buzz.agents2.v1")).toBeNull();
  expect(storage.getItem(STORAGE_KEY)).toBe("exact bytes");
});

it("refuses to overwrite conflicting settings without stopping startup", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const storage = memoryStorage();
  storage.setItem("buzz.agents2.v1", "old");
  storage.setItem(STORAGE_KEY, "new");
  storage.setItem("buzz.agents2.teams.v1", "teams");
  await migrateAgentStorage(storage);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("already contains different data"),
  );
  expect(storage.getItem("buzz.agents2.v1")).toBe("old");
  expect(storage.getItem(STORAGE_KEY)).toBe("new");
  expect(storage.getItem(TEAMS_KEY)).toBe("teams");
  error.mockRestore();
});
