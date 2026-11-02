import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegistration, registrationIntent } from "./registration";

const target = "https://builderlab.example/api/goose";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("isolates server and name and stores only the creation intent", () => {
  const a = registrationIntent(target, "account-a", "Helper");
  expect(
    registrationIntent("https://other.example/api/goose", "account-a", "Helper")
      .key,
  ).not.toBe(a.key);
  expect(registrationIntent(target, "account-a", "Another").key).not.toBe(
    a.key,
  );
  expect(
    Object.keys(JSON.parse(localStorage.getItem(a.storageKey) ?? "{}")),
  ).toEqual(["key", "createdAt"]);
});
it("rejects an expired key instead of silently generating another", () => {
  registrationIntent(target, "account", "Helper");
  vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
  expect(() => registrationIntent(target, "account", "Helper")).toThrow(
    "cannot be retried safely",
  );
});
it("refuses corrupt pending records and preserves a newer intent when clearing", () => {
  const a = registrationIntent(target, "account", "Helper");
  const b = crypto.randomUUID();
  localStorage.setItem(
    a.storageKey,
    JSON.stringify({ key: b, createdAt: Date.now() }),
  );
  clearRegistration(a);
  expect(registrationIntent(target, "account", "Helper").key).toBe(b);
  localStorage.setItem(a.storageKey, "{");
  expect(() => registrationIntent(target, "account", "Helper")).toThrow(
    "Could not read",
  );
});
it("replays the picture a pending creation was first made with", () => {
  const a = registrationIntent(target, "account", "Helper", "https://a.png");
  expect(a.picture).toBe("https://a.png");
  const replay = registrationIntent(
    target,
    "account",
    "Helper",
    "https://b.png",
  );
  expect(replay).toEqual(a);
  expect(
    registrationIntent(target, "account", "Plain").picture,
  ).toBeUndefined();
});
