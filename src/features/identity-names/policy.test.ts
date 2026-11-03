import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { resolveIdentityNames, type NamingIdentity } from "./policy";

const me = "1".repeat(64),
  wes = "2".repeat(64);
const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64);
const person = (pubkey: string, name = "Honey"): NamingIdentity => ({
  pubkey,
  name,
});
const agent = (
  pubkey: string,
  ownerPubkey?: string,
  name = "Honey",
): NamingIdentity => ({
  pubkey,
  name,
  isAgent: true,
  ...(ownerPubkey ? { ownerPubkey } : {}),
});
const suffix = (key: string) => npubEncode(key).slice(-4);
const owners = [person(me, "Logan"), person(wes, "Wes")];
function labels(rows: NamingIdentity[], viewer = me) {
  const resolved = resolveIdentityNames([...owners, ...rows], viewer);
  expect(resolveIdentityNames([...owners, ...rows].reverse(), viewer)).toEqual(
    resolved,
  );
  return rows.map((row) => resolved.get(row.pubkey)?.name);
}
it("prefers humans before agents, then mine before others", () => {
  expect(labels([person(c), agent(a, me), agent(b, wes)])).toEqual([
    "Honey",
    "Honey (agent)",
    "Wes’s Honey",
  ]);
  expect(labels([agent(a, me), agent(b, wes)])).toEqual([
    "Honey",
    "Wes’s Honey",
  ]);
  expect(labels([agent(a, me), agent(b, wes)], wes)).toEqual([
    "Logan’s Honey",
    "Honey",
  ]);
});
it("keeps the viewer plain in human collisions and otherwise suffixes both", () => {
  expect(labels([person(me, "Logan"), person(a, "Logan")])).toEqual([
    "Logan",
    `Logan · ${suffix(a)}`,
  ]);
  expect(labels([person(a), person(b)])).toEqual([
    `Honey · ${suffix(a)}`,
    `Honey · ${suffix(b)}`,
  ]);
});

it("normalizes viewer, owner, candidates and repeated keys at the API boundary", () => {
  const viewer = "d".repeat(64);
  const identities = [
    person(viewer, "Logan"),
    agent(a, viewer.toUpperCase()),
    agent(b, wes),
    person(wes, "Wes"),
  ];
  const names = resolveIdentityNames(identities, viewer.toUpperCase(), [
    a.toUpperCase(),
    b.toUpperCase(),
  ]);
  expect(names.get(a)?.name).toBe("Honey");
  expect(names.get(b)?.name).toBe("Wes’s Honey");
  expect(names.size).toBe(2);
  expect(
    resolveIdentityNames(
      [person(viewer, "Alex"), person(a, "Alex")],
      viewer.toUpperCase(),
    ).get(viewer)?.name,
  ).toBe("Alex");
});

it("reads only the selected keys and their owners from the directory", () => {
  let read = 0;
  const directory = Array.from({ length: 1000 }, (_, index) => ({
    pubkey: index.toString(16).padStart(64, "0"),
    get name() {
      read++;
      return "Honey";
    },
  }));
  const names = resolveIdentityNames(
    [...directory, person(wes, "Wes"), agent(a, wes), person(b)],
    me,
    [a, b],
  );
  expect(names.get(a)?.name).toBe("Wes’s Honey");
  expect(names.get(b)?.name).toBe("Honey");
  expect(read).toBe(0);
});

it("compares all aliases while returning the last requested alias for each key", () => {
  const rows = [
    agent(a, me),
    agent(b, me),
    { ...agent(a, me), name: "Juniper" },
    { ...agent(b, me), name: "Juniper" },
  ];
  for (const ordered of [rows, [...rows].reverse()]) {
    for (const requested of rows) {
      const resolved = resolveIdentityNames([...ordered, requested], me);
      expect(resolved.get(requested.pubkey)?.name).toBe(
        `${requested.name} · ${suffix(requested.pubkey)}`,
      );
    }
  }
  const oneKey = [
    agent(a, me),
    { ...agent(a, me), name: "Juniper" },
    agent(a, me),
  ];
  expect(resolveIdentityNames(oneKey, me).get(a)?.name).toBe("Honey");
});

it("rechecks generated labels against aliases and keeps human priority", () => {
  const literal = `Honey · ${suffix(a)}`;
  const rows = [
    agent(a, me),
    agent(b, me),
    person(c, literal),
    person(c, "Juniper"),
  ];
  const names = resolveIdentityNames(rows, me);
  expect(names.get(a)?.name).toBe(`Honey · ${npubEncode(a).slice(-5)}`);
  expect(names.get(c)?.name).toBe("Juniper");
  expect(
    resolveIdentityNames([...rows, person(c, literal)], me).get(c)?.name,
  ).toBe(literal);
});

const conformance = JSON.parse(
  readFileSync(
    new URL(
      "../../bundled/identity-naming/identity-names.fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  version: number;
  cases: {
    name: string;
    identities: NamingIdentity[];
    viewer?: string;
    candidates?: string[];
    expected: Record<string, { name: string; qualifier: string | null }>;
  }[];
};
it("validates the portable fixture version and non-empty case list", () => {
  expect(conformance.version).toBe(1);
  expect(conformance.cases.length).toBeGreaterThan(0);
});
it.each(conformance.cases)(
  "conforms to the portable naming contract: $name",
  (fixture) => {
    const actual = resolveIdentityNames(
      fixture.identities,
      fixture.viewer,
      fixture.candidates,
    );
    expect(
      Object.fromEntries(
        [...actual].map(([key, value]) => [
          key,
          { name: value.name, qualifier: value.qualifier ?? null },
        ]),
      ),
    ).toEqual(fixture.expected);
  },
);
