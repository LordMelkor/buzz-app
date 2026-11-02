import { expect, it } from "vitest";
import {
  editSidebarRecord,
  nextSidebarSectionOrder,
} from "./sidebar-registers";
import { projectSidebarPreferences } from "./sidebar-preferences";
const dev = "1234567890abcdef";
const reg = (value: unknown, v = 100) => [v, dev, value];
const sections = () => ({
  version: 1,
  sections: [],
  assignments: {},
  meta: {
    v: 1,
    s: {
      live: {
        name: reg("Work"),
        order: reg(99),
        live: reg(true),
        icon: reg(null),
      },
      dead: { name: reg("Deleted"), live: reg(false), order: reg(1000) },
    },
    a: { a: reg("live"), removed: reg(null), orphan: reg("dead") },
  },
});
it("reads metadata rather than stale legacy projections and preserves deletion registers", () => {
  const current = sections();
  expect(projectSidebarPreferences(current, undefined)).toEqual({
    sections: [{ id: "live", name: "Work", order: 0 }],
    assignments: { a: "live" },
    starred: [],
    muted: [],
  });
  const next = editSidebarRecord(
    "channel-sections",
    current,
    1,
    [[["a", "a"], null]],
    50,
  );
  expect(projectSidebarPreferences(next, undefined).assignments).toEqual({});
  expect(next.meta).toEqual({
    ...current.meta,
    a: {
      ...current.meta.a,
      a: [101, expect.stringMatching(/^[0-9a-f]{16}$/), null],
    },
  });
  expect(current.meta.a.a).toEqual(reg("live"));
  expect(
    editSidebarRecord("channel-sections", next, 1, [[["a", "a"], null]]),
  ).toBe(next);
  expect(nextSidebarSectionOrder(current)).toBe(100);
});
it("prepends before canonical negative orders without counting deleted sections", () => {
  const current = editSidebarRecord(
    "channel-sections",
    sections(),
    1,
    [
      [["s", "live", "order"], -7],
      [["s", "dead", "order"], -100],
    ],
    110,
  );
  expect(nextSidebarSectionOrder(current, "first")).toBe(-8);
  expect(
    nextSidebarSectionOrder({ sections: [{ order: -2.4 }] }, "first"),
  ).toBe(-3);
  expect(nextSidebarSectionOrder({ sections: [] }, "first")).toBe(-1);
});

it("imports a meta-less head at event milliseconds and edits only the requested leaf", () => {
  const next = editSidebarRecord(
    "channel-sort",
    { version: 1, groups: { channels: "recent", forums: "recent" } },
    10,
    [[["g", "channels"], null]],
    1,
  );
  expect(next).toEqual({
    version: 1,
    groups: { forums: "recent" },
    meta: {
      v: 1,
      g: {
        channels: [10001, expect.stringMatching(/^[0-9a-f]{16}$/), null],
        forums: [10000, "0000000000000000", "recent"],
      },
    },
  });
});
it("keeps tombstones beyond the live projection cap and refuses too many live values", () => {
  const tombstones = Object.fromEntries(
    Array.from({ length: 105 }, (_, i) => [`section:${i}`, reg(null)]),
  );
  const value = { version: 1, groups: {}, meta: { v: 1, g: tombstones } };
  const next = editSidebarRecord("channel-sort", value, 1, [
    [["g", "channels"], "recent"],
  ]);
  expect(
    projectSidebarPreferences(undefined, undefined, undefined, next).sort,
  ).toEqual({ channels: "recent" });
  expect(Object.keys((next.meta as typeof value.meta).g)).toHaveLength(106);
  expect(() =>
    projectSidebarPreferences(undefined, undefined, undefined, {
      ...value,
      meta: {
        v: 1,
        g: Object.fromEntries(
          Object.keys(tombstones).map((key) => [key, reg("recent")]),
        ),
      },
    }),
  ).toThrow("budget");
});
it("uses own properties for dynamic keys without changing object prototypes", () => {
  const next = editSidebarRecord("channel-sections", sections(), 1, [
    [["a", "constructor"], "live"],
  ]);
  expect(projectSidebarPreferences(next, undefined).assignments).toEqual({
    a: "live",
    constructor: "live",
  });
  expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  expect(() =>
    editSidebarRecord("channel-sections", sections(), 1, [
      [["a", "__proto__"], "live"],
    ]),
  ).toThrow();
});
it.each([
  null,
  { v: 2 },
  { v: 1, g: null },
  { v: 1, other: {} },
  { v: 1, g: { channels: [1, dev] } },
  { v: 1, g: { channels: [1, dev, "no"] } },
  { v: 1, g: { channels: [1.1, dev, "recent"] } },
  { v: 1, g: { channels: [-1, dev, "recent"] } },
  { v: 1, g: { channels: [1, "bad", "recent"] } },
  { v: 1, g: { channels: [Number.MAX_SAFE_INTEGER + 1, dev, "recent"] } },
])("fails closed on unsupported or malformed metadata: %j", (meta) => {
  const value = { version: 1, groups: {}, meta };
  expect(() =>
    projectSidebarPreferences(undefined, undefined, undefined, value),
  ).toThrow();
  expect(() =>
    editSidebarRecord("channel-sort", value, 1, [
      [["g", "channels"], "recent"],
    ]),
  ).toThrow();
});
it("refuses an exhausted register clock instead of emitting unsafe integers", () => {
  expect(() =>
    editSidebarRecord(
      "channel-sort",
      {
        version: 1,
        groups: {},
        meta: { v: 1, g: { channels: reg(null, Number.MAX_SAFE_INTEGER) } },
      },
      1,
      [[["g", "channels"], "recent"]],
    ),
  ).toThrow("clock exhausted");
});

it.each(["name", "icon"])(
  "read tolerance does not admit oversized live %s or rewrite retained text",
  (field) => {
    const current = sections();
    const meta = {
      ...current.meta,
      s: {
        ...current.meta.s,
        live: { ...current.meta.s.live, [field]: reg("x".repeat(257)) },
      },
    };
    expect(() =>
      projectSidebarPreferences({ ...current, meta }, undefined),
    ).toThrow("Invalid sidebar preference text");
    const dead = {
      ...current,
      meta: {
        ...meta,
        s: { ...meta.s, live: { ...meta.s.live, live: reg(false) } },
      },
    };
    const before = structuredClone(dead);
    expect(projectSidebarPreferences(dead, undefined).sections).toEqual([]);
    expect(
      editSidebarRecord("channel-sections", dead, 1, [[["a", "a"], null]]),
    ).toBe(dead);
    expect(() =>
      editSidebarRecord("channel-sections", dead, 1, [
        [["s", "dead", "icon"], null],
      ]),
    ).toThrow("Invalid sidebar register");
    expect(dead).toEqual(before);
  },
);

it("does not salvage malformed register envelopes or unknown retained fields on reads or writes", () => {
  for (const dead of [
    { name: [1, "bad-device", "x".repeat(257)], live: reg(false) },
    { name: reg("Deleted"), live: reg(false), future: reg("keep") },
  ]) {
    const current = sections();
    const value = {
      ...current,
      meta: { ...current.meta, s: { ...current.meta.s, dead } },
    };
    const before = structuredClone(value);
    expect(() => projectSidebarPreferences(value, undefined)).toThrow();
    expect(() =>
      editSidebarRecord("channel-sections", value, 1, [[["a", "a"], null]]),
    ).toThrow();
    expect(value).toEqual(before);
  }
});

it("keeps missing-assignment removal a no-op without suppressing other null registers", () => {
  const current = sections();
  expect(
    editSidebarRecord("channel-sections", current, 1, [
      [["a", "missing"], null],
    ]),
  ).toBe(current);
  const next = editSidebarRecord("channel-sections", current, 1, [
    [["s", "dead", "icon"], null],
  ]);
  expect(next).not.toBe(current);
  expect(next.meta).toMatchObject({
    s: { dead: { icon: [expect.any(Number), expect.any(String), null] } },
  });
  const sort = { version: 1, groups: {}, meta: { v: 1, g: {} } };
  expect(
    editSidebarRecord("channel-sort", sort, 1, [[["g", "channels"], null]])
      .meta,
  ).toMatchObject({
    g: { channels: [expect.any(Number), expect.any(String), null] },
  });
});
