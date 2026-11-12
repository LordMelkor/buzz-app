// @vitest-environment node
import { it, expect } from "vitest";
import { profileCuts, channelCuts } from "./references";

it.each([
  "[@Ana](x) @Ana",
  "![a @Ana](x) @Ana",
  "[[a @Ana](x) @Ana",
  "[@Ana][ref] @Ana",
  "[a][x][@Ana](y) @Ana",
  "[a][x[@Ana](y) @Ana",
  "[bad]\n[a @Ana](x) @Ana",
  "[bad](\n[a @Ana](x) @Ana",
])("keeps complete link/image exclusions and line boundaries: %s", (source) => {
  const start = source.lastIndexOf("@Ana");
  expect(profileCuts(source, ["Ana"], [])).toEqual({
    cuts: [{ start, end: start + 4 }],
    unknown: [],
  });
});
it.each([
  "[a[b[c @Ana",
  "[a]([b]([c @Ana",
  "[a][b[c @Ana",
  "[a @Ana](broken\n@Ana",
])("does not protect mentions in malformed link syntax: %s", (source) => {
  const starts = [...source.matchAll(/@Ana/g)].map((match) => match.index);
  expect(profileCuts(source, ["Ana"], [])).toEqual({
    cuts: starts.map((start) => ({ start, end: start + 4 })),
    unknown: [],
  });
});

it("retains literal overlaps at the far end of a candidate name", () => {
  expect(profileCuts("@Ana`x`", ["Ana`x`"], [{ start: 4, end: 7 }])).toEqual({
    cuts: [],
    unknown: [{ start: 0, end: 7 }],
  });
});

it("preserves candidate-overlap checks for unsorted literal inputs", () => {
  expect(
    profileCuts(
      "@Ana`x` @Ana`y`",
      ["Ana`x`", "Ana`y`"],
      [
        { start: 12, end: 15 },
        { start: 4, end: 7 },
      ],
    ),
  ).toEqual({
    cuts: [],
    unknown: [
      { start: 0, end: 7 },
      { start: 8, end: 15 },
    ],
  });
});

it.each([
  {
    text: "#a.b #a",
    names: ["a", "a.b"],
    cuts: [
      { start: 0, end: 4 },
      { start: 5, end: 7 },
    ],
  },
  {
    text: "#a #b.c #b",
    names: ["b.c", "a", "b"],
    cuts: [
      { start: 0, end: 2 },
      { start: 3, end: 7 },
      { start: 8, end: 10 },
    ],
  },
  {
    text: "#a #long.name",
    names: ["long.name", "a #long"],
    cuts: [{ start: 3, end: 13 }],
  },
])(
  "preserves longest-first channel overlaps across out-of-order cuts: $text",
  ({ text, names, cuts }) => {
    expect(channelCuts(text, names)).toEqual(cuts);
  },
);
