import { expect, it, vi } from "vitest";
import { dmLabel } from "./dm-label";
import { sortParticipantNames } from "../../features/identity-names/participant-order";
import { publicKeyLabels } from "../../shared/identity/public-key";

it("orders names alphabetically before bounding, with the full namesake comparison set", () => {
  const keys = ["a", "b", "c", "d"].map((c) => c.repeat(64));
  const profiles = new Map(keys.map((key) => [key, { name: "Same" }]));
  const suffix = publicKeyLabels(keys);
  const resolve = vi.fn(
    (key: string, fallback: string) => `${fallback} · ${suffix.get(key)}`,
  );
  const names = sortParticipantNames(
    keys.map((key) => `Same · ${suffix.get(key)}`),
  );
  expect(dmLabel(keys, profiles, resolve)).toBe(
    `${names.slice(0, 3).join(", ")} +1`,
  );
  expect(resolve).toHaveBeenCalledTimes(4);
  for (const key of keys)
    expect(resolve).toHaveBeenCalledWith(key, "Same", keys);
});
it("matches the sidebar's alphabetical order, ignoring case", () => {
  const [kenny, baxen, wes, cynthia] = ["k", "b", "w", "c"].map((c) =>
    c.repeat(64),
  ) as [string, string, string, string];
  const profiles = new Map([
    [kenny, { name: "Kenny Lopez" }],
    [baxen, { name: "baxen" }],
    [wes, { name: "Wes" }],
    [cynthia, { name: "Cynthia" }],
  ]);
  const resolve = (_key: string, fallback: string) => fallback;
  expect(dmLabel([kenny, baxen, wes], profiles, resolve)).toBe(
    "baxen, Kenny Lopez, Wes",
  );
  expect(dmLabel([wes, kenny, cynthia, baxen], profiles, resolve)).toBe(
    "baxen, Cynthia, Kenny Lopez +1",
  );
});
it("preserves missing-roster versus self-DM fallback and uses public labels for unnamed participants", () => {
  const key = "a".repeat(64),
    names = new Map();
  const resolve = (_key: string, fallback: string) => fallback;
  expect(dmLabel(undefined, names, resolve, "Room name")).toBe("Room name");
  expect(dmLabel([], names, resolve, "Room name")).toBe("Notes to self");
  expect(dmLabel(undefined, names, resolve)).toBe("Notes to self");
  expect(dmLabel([key], names, resolve)).toBe(publicKeyLabels([key]).get(key));
});
