import { expect, it } from "vitest";
import { managedBy, pendingManaged } from "./managed";
import type { ManagedEntry, ManagedPlugins } from "./types";

const entry = (id: string, state: ManagedEntry["state"]): ManagedEntry => ({
  id,
  repository: "https://example.com/plugins",
  reference: "v1",
  commit: "0".repeat(40),
  path: ".",
  state,
});
const policy = (...plugins: ManagedEntry[]): ManagedPlugins => ({
  status: "ready",
  path: "/managed-plugins.json",
  source: "Example Org",
  plugins,
  problems: [],
});

it("counts only recommendations that still need the user", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(pendingManaged(managed).map(({ id }) => id)).toEqual([
    "a.missing",
    "b.outdated",
  ]);
  expect(pendingManaged(undefined)).toEqual([]);
  expect(
    pendingManaged({ status: "invalid", path: "/p", reason: "Bad" }),
  ).toEqual([]);
});

it("attributes installed plugins to their managing source", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(managedBy(managed, "c.current")?.source).toBe("Example Org");
  expect(managedBy(managed, "b.outdated")?.source).toBe("Example Org");
  for (const id of ["a.missing", "d.other", "unlisted"])
    expect(managedBy(managed, id)).toBeUndefined();
  expect(managedBy(undefined, "c.current")).toBeUndefined();
});
