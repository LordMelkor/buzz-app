// Lexical grammar, exact token spelling and bounded UTF-8 output.
import { expect, it } from "vitest";
import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "./formats";
import { required, MAX_RENDER_DEPTH } from "./markdown-limits";
import { indentJson } from "./json";

it.each([
  [
    ' { "a" : [1.0, 1e+99, 12345678901234567890], "a" : -0 } ',
    '{\n  "a": [\n    1.0,\n    1e+99,\n    12345678901234567890\n  ],\n  "a": -0\n}',
  ],
  [
    String.raw`{"\u0061":"quote\" [ ] { } \\ \/ \u00aF", "raw":"雪😀"}`,
    "{" +
      "\n  " +
      String.raw`"\u0061": "quote\" [ ] { } \\ \/ \u00aF",` +
      "\n  " +
      '"raw": "雪😀"' +
      "\n}",
  ],
  [
    "\t\r\n[{}, [], true, false, null, -1.2300E-09]\r\n",
    "[\n  {},\n  [],\n  true,\n  false,\n  null,\n  -1.2300E-09\n]",
  ],
  [
    ' { "nested" : { "x" : [ [ 0 ] ] } } ',
    '{\n  "nested": {\n    "x": [\n      [\n        0\n      ]\n    ]\n  }\n}',
  ],
  [" { } ", "{}"],
  [" [ ] ", "[]"],
  [" 1.0 ", "1.0"],
  [" 1e+999 ", "1e+999"],
  [" true\t", "true"],
  ["false", "false"],
  ["null", "null"],
  ['"a b"', '"a b"'],
] as const)(
  "indents valid JSON without rewriting tokens: %s",
  (source, expected) => {
    expect(indentJson(source)).toBe(expected);
    expect(indentJson(expected)).toBe(expected); // Unchanged success is not rejection.
  },
);

it.each([
  "",
  " \t\n\r",
  "\uFEFF{}",
  "\u00a0{}",
  "{}\v",
  "{a:1}",
  '{"a" 1}',
  '{"a":}',
  '{"a":1,}',
  '{"a":1 "b":2}',
  '{"a":1]',
  "[,1]",
  "[1,]",
  "[1 2]",
  "[}",
  "[",
  "{",
  "{}[]",
  "true false",
  "tru",
  "undefined",
  "00",
  "-01",
  ".1",
  "1.",
  "+1",
  "-",
  "1e",
  "1e+",
  "NaN",
  "Infinity",
  '"unterminated',
  '"literal\nline"',
  '"\u0000"',
  String.raw`"\x00"`,
  String.raw`"\u12"`,
  String.raw`"\uZZZZ"`,
  '"escape\\',
])("rejects invalid JSON without throwing: %s", (source) => {
  expect(indentJson(source)).toBeUndefined();
});

it("accepts the maximum container depth and rejects the next level", () => {
  const nested = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
  const accepted = indentJson(nested(MAX_RENDER_DEPTH));
  expect(accepted).toBeDefined();
  expect(JSON.parse(required(accepted))).toEqual(
    JSON.parse(nested(MAX_RENDER_DEPTH)),
  );
  expect(indentJson(nested(MAX_RENDER_DEPTH + 1))).toBeUndefined();
  expect(indentJson("[".repeat(100_000))).toBeUndefined();
});

it("counts UTF-8 bytes at the output boundary, including raw surrogate pairs", () => {
  // Independent payload sizes: two quotes plus one ASCII byte per character.
  const exact = '"' + "x".repeat(MAX_FETCH_BYTES - 2) + '"';
  expect(indentJson(exact)).toBe(exact);
  expect(
    indentJson('"' + "x".repeat(MAX_FETCH_BYTES - 1) + '"'),
  ).toBeUndefined();
  // Replacing four ASCII bytes with one emoji leaves the exact byte budget.
  const unicode = '"' + "x".repeat(MAX_FETCH_BYTES - 6) + '😀"';
  expect(indentJson(unicode)).toBe(unicode);
  expect(
    indentJson('"' + "x".repeat(MAX_FETCH_BYTES - 5) + '😀"'),
  ).toBeUndefined();
});

it("rejects indentation expansion beyond the byte budget from a small input", () => {
  const source =
    "[".repeat(MAX_RENDER_DEPTH) +
    Array(104_000).fill("0").join(",") +
    "]".repeat(MAX_RENDER_DEPTH);
  // 100 wrappers and 104,000 values would format to 21,132,198 ASCII bytes.
  expect(source.length).toBeLessThan(MAX_FETCH_BYTES);
  expect(indentJson(source)).toBeUndefined();
});
