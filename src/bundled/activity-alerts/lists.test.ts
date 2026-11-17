// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { MAX_ENTRIES, peopleList } from "./lists";

afterEach(() => localStorage.clear());

const key = (n: number) => n.toString(16).padStart(64, "0");

it("keeps up to 200 people per account and refuses one more", () => {
  const list = peopleList();
  for (let n = 0; n < MAX_ENTRIES; n++)
    expect(list.set("me", key(n), true)).toBe(true);
  expect(list.set("me", key(MAX_ENTRIES), true)).toBe(false);
  expect(list.get("me")).toHaveLength(MAX_ENTRIES);
  expect(list.get("other account")).toEqual([]);
  // Freeing a slot lets the next one in.
  list.set("me", key(0), false);
  expect(list.set("me", key(MAX_ENTRIES), true)).toBe(true);
});

it("reads a damaged or foreign value as empty, and hears another window", () => {
  const list = peopleList();
  const heard = vi.fn();
  const stop = list.subscribe(heard);
  const stored = "buzz-activity-alerts.people.v1:me";
  /** Another window writes this device's storage. */
  const write = (value: string) => {
    localStorage.setItem(stored, value);
    window.dispatchEvent(new StorageEvent("storage", { key: stored }));
  };
  write("{not json");
  expect(list.get("me")).toEqual([]);
  write(JSON.stringify(["not a key", key(1), key(1)]));
  expect(list.get("me")).toEqual([key(1)]);
  expect(heard).toHaveBeenCalledTimes(2);
  stop();
});
