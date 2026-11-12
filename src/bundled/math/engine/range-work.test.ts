// @vitest-environment node
// Deterministic work measurements of the actual cursor kernels, not wall time.
// Getter-backed ranges preserve values and count every start/end property read.
import { it, expect, vi } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { scansIn, indexMessage, hostSegments } from "./detect";
import { punctuationEntities, protectEntities } from "./entities";
import { protectSpoilers, spoilerLayout, spoilerMarkers } from "./spoilers";
import { profileCuts } from "./references";

type Range = { start: number; end: number };
type RangeWorkKind = "scan-cuts" | "scan-unknown" | "spoiler-markers";
const rangeWorkKinds: readonly RangeWorkKind[] = [
  "scan-cuts",
  "scan-unknown",
  "spoiler-markers",
];
function track(ranges: Range[]) {
  let reads = 0;
  return {
    ranges: ranges.map((range) => ({
      get start() {
        reads++;
        return range.start;
      },
      get end() {
        reads++;
        return range.end;
      },
    })),
    reads: () => reads,
  };
}

function measureRangeWork(kind: RangeWorkKind, count = 1024) {
  let input: ReturnType<typeof track>, semantic: boolean;
  if (kind === "spoiler-markers") {
    const source = "||x||\n\n".repeat(count);
    const plain = Array.from({ length: count }, (_, i) => [
      { start: i * 7, end: i * 7 + 2 },
      { start: i * 7 + 3, end: i * 7 + 5 },
    ]).flat();
    const tree = fromMarkdown(protectSpoilers(source, plain));
    input = track(plain);
    const layout = spoilerLayout(tree, input.ranges);
    semantic =
      layout.edges.length === count * 2 &&
      layout.marks.length === count &&
      layout.edges[0]?.start === 0 &&
      layout.edges.at(-1)?.end === (count - 1) * 7 + 5;
  } else {
    const source = `${"p\n\n".repeat(count)}$z$`;
    input = track(
      Array.from({ length: count }, (_, i) => ({
        start: i * 3,
        end: i * 3 + 1,
      })),
    );
    const cuts = kind === "scan-cuts" ? input.ranges : [],
      unknown = kind === "scan-unknown" ? input.ranges : [];
    const runs = scansIn(
      fromMarkdown(source),
      source,
      { singleDollar: true },
      new Map(),
      cuts,
      unknown,
      new Uint8Array(source.length),
      new Uint32Array(source.length + 1),
    );
    const spans = runs.flatMap((run) => run.result.spans);
    semantic =
      runs.length === (kind === "scan-cuts" ? 2 * count + 1 : 1) &&
      spans.length === 1 &&
      spans[0]?.tex === "z";
  }
  return {
    kind,
    count,
    ranges: input.ranges.length,
    reads: input.reads(),
    budget: 128 * input.ranges.length,
    semantic,
  };
}

// Observe the real profile guard's search primitives, without production
// counters. These malformed, single-line suffixes have no required closer:
// each failed legacy link regexp searches its whole input, while indexOf
// searches exactly [from, found+1) or [from, EOF). Other regexes are not counted.
function measureLinkWork(malformed: string, bound = true) {
  const source = `[a @Ana](x) ${malformed} @Ana`,
    start = source.lastIndexOf("@Ana");
  const legacy = /^!?\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])/.source;
  const exec = RegExp.prototype.exec,
    indexOf = String.prototype.indexOf;
  let searched = 0,
    linkSearches = 0;
  const regex = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
    this: RegExp,
    value: string,
  ) {
    const result = exec.call(this, value);
    if (this.source === legacy && !result) {
      searched += value.length;
      linkSearches++;
    }
    return result;
  });
  const index = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, needle: string, from = 0) {
      const result = indexOf.call(this, needle, from);
      if (String(this) === source && ["]", ")", "\n"].includes(needle)) {
        searched += (result < 0 ? source.length : result + 1) - from;
        if (needle !== "\n") linkSearches++;
      }
      return result;
    });
  let result: ReturnType<typeof profileCuts>;
  try {
    result = profileCuts(source, bound ? ["Ana"] : [], []);
  } finally {
    index.mockRestore();
    regex.mockRestore();
  }
  expect(result).toEqual(
    bound
      ? { cuts: [{ start, end: start + 4 }], unknown: [] }
      : { cuts: [], unknown: [{ start, end: start + 1 }] },
  );
  return {
    searched,
    linkSearches,
    length: source.length,
    budget: 32 * source.length,
  };
}

it.each([
  ["unfinished labels", "[a".repeat(1536), true],
  ["unfinished parenthesized targets", "[a](".repeat(1536), true],
  ["unfinished reference target", `[a][${"b[".repeat(1536)}`, true],
  ["unfinished labels without signed recipients", "[a".repeat(1536), false],
] as const)(
  "bounds failed link-search work independently of CPU speed: %s",
  (_label, malformed, bound) => {
    const result = measureLinkWork(malformed, bound);
    expect(
      result.linkSearches,
      "must observe actual link-delimiter searches",
    ).toBeGreaterThan(0);
    expect(
      result.searched,
      "must include the real whole-line search",
    ).toBeGreaterThanOrEqual(result.length);
    expect(
      result.searched,
      "linear link-search character budget",
    ).toBeLessThanOrEqual(result.budget);
  },
);

it.each(rangeWorkKinds)(
  "bounds source-range reads independently of CPU speed: %s",
  (kind) => {
    const result = measureRangeWork(kind);
    expect(
      result.semantic,
      "the real kernel must still process every container/marker",
    ).toBe(true);
    expect(
      result.reads,
      "instrumentation must observe range processing",
    ).toBeGreaterThanOrEqual(result.ranges);
    expect(result.reads, "linear range-read work budget").toBeLessThanOrEqual(
      result.budget,
    );
  },
);

it("bounds entity-container discovery and protection work", () => {
  const count = 1024,
    source = `${"&#58;\n\n".repeat(count)}$z$`,
    original = String.prototype.matchAll;
  let scans = 0,
    scannedCharacters = 0;
  const spy = vi
    .spyOn(String.prototype, "matchAll")
    .mockImplementation(function (this: string, pattern: RegExp) {
      if (String(this) === source) {
        scans++;
        scannedCharacters += this.length;
      }
      return original.call(this, pattern);
    });
  let cuts: ReturnType<typeof punctuationEntities>;
  try {
    cuts = punctuationEntities(source, []);
  } finally {
    spy.mockRestore();
  }
  expect(cuts).toHaveLength(count);
  expect(
    scans,
    "instrumentation must observe entity discovery",
  ).toBeGreaterThan(0);
  expect(
    scannedCharacters,
    "entity discovery scans a bounded number of source passes",
  ).toBeLessThanOrEqual(2 * source.length);
  const input = track(cuts),
    protectedSource = protectEntities(source, input.ranges);
  expect(protectedSource).toHaveLength(source.length);
  expect(
    input.reads(),
    "entity protection must consume each source range a bounded number of times",
  ).toBeLessThanOrEqual(4 * count);
});

it("bounds unresolved-reference container work", () => {
  const count = 1024,
    source = `${"@a\n\n".repeat(count)}$z$`,
    indexOf = String.prototype.indexOf,
    exec = RegExp.prototype.exec;
  let newlineScans = 0,
    searched = 0,
    regexCalls = 0;
  const index = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, needle: string, from = 0) {
      const result = indexOf.call(this, needle, from);
      if (String(this) === source && needle === "\n") {
        newlineScans++;
        searched += (result < 0 ? source.length : result + 1) - from;
      }
      return result;
    });
  const regex = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
    this: RegExp,
    value: string,
  ) {
    regexCalls++;
    return exec.call(this, value);
  });
  let result: ReturnType<typeof profileCuts>;
  try {
    result = profileCuts(source, [], []);
  } finally {
    regex.mockRestore();
    index.mockRestore();
  }
  expect(result.cuts).toEqual([]);
  expect(result.unknown).toHaveLength(count);
  expect(
    newlineScans,
    "instrumentation must observe line-boundary searches",
  ).toBeGreaterThan(0);
  expect(
    newlineScans,
    "line-boundary searches must not repeat for each unresolved reference",
  ).toBeLessThanOrEqual(2 * count + 2);
  expect(
    searched,
    "line-boundary search characters must remain linear",
  ).toBeLessThanOrEqual(source.length);
  expect(
    regexCalls,
    "unresolved references must not trigger repeated regex work",
  ).toBeLessThanOrEqual(16 * count);
});

it("bounds spoiler-container marker scans", () => {
  const count = 1024,
    source = "||x||\n\n".repeat(count),
    tree = fromMarkdown(source),
    original = String.prototype.matchAll;
  let scans = 0,
    scannedCharacters = 0;
  const spy = vi
    .spyOn(String.prototype, "matchAll")
    .mockImplementation(function (this: string, pattern: RegExp) {
      if (pattern.source === "\\\\[\\s\\S]|\\|\\|") {
        scans++;
        scannedCharacters += this.length;
      }
      return original.call(this, pattern);
    });
  let markers: ReturnType<typeof spoilerMarkers>;
  try {
    markers = spoilerMarkers(tree, source, new Set());
  } finally {
    spy.mockRestore();
  }
  expect(markers).toHaveLength(2 * count);
  expect(
    scans,
    "instrumentation must observe spoiler marker scanning",
  ).toBeGreaterThan(0);
  expect(
    scannedCharacters,
    "spoiler marker scans must stay linear in text-node content",
  ).toBeLessThanOrEqual(source.length);
});

// Recovery must advance through general prose without re-searching the whole
// source for percent on each malformed-verb line. Exercise the public index.
it("bounds comment-discovery searches across non-TeX prose", () => {
  const source =
    "\\begin{equation}a\\end{equation}\n" +
    "say \\verb command\n".repeat(1024) +
    "\\begin{align}\n% \\begin{align}\na&=b\n\\end{align}";
  const includes = String.prototype.includes;
  let searched = 0;
  const spy = vi
    .spyOn(String.prototype, "includes")
    .mockImplementation(function (this: string, needle: string, from = 0) {
      if (String(this) === source && needle === "%")
        searched += source.length - from;
      return includes.call(this, needle, from);
    });
  try {
    expect(indexMessage(source, { singleDollar: true }).drawn).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
  expect(searched).toBeGreaterThanOrEqual(source.length);
  expect(searched).toBeLessThanOrEqual(4 * source.length);
});

it.each([false, true])(
  "bounds literal-range reads for recipient matching, bound=%s",
  (bound) => {
    const source = `${"`x` @Ana ".repeat(1024)}\n\n$x$`,
      ranges: Range[] = [];
    function visit(
      node:
        | ReturnType<typeof fromMarkdown>
        | {
            type: string;
            position?: { start: { offset?: number }; end: { offset?: number } };
            children?: unknown[];
          },
    ) {
      if (node.type === "inlineCode") {
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        if (start === undefined || end === undefined)
          throw Error("inlineCode without source offsets");
        ranges.push({ start, end });
      } else if ("children" in node)
        for (const child of node.children ?? []) visit(child as typeof node);
    }
    visit(fromMarkdown(source));
    expect(ranges).toHaveLength(1024);
    const input = track(ranges),
      result = profileCuts(source, bound ? ["Ana"] : [], input.ranges);
    expect(result.cuts).toHaveLength(bound ? 1024 : 0);
    expect(result.unknown).toHaveLength(bound ? 0 : 1024);
    expect(input.reads()).toBeGreaterThanOrEqual(ranges.length);
    expect(input.reads()).toBeLessThanOrEqual(128 * ranges.length);
  },
);

it("bounds decoded-line searches on NUL-bearing paragraphs", () => {
  const source = `${"\0 projection-line\n".repeat(1024)}\0 $x$`,
    normalized = source.replaceAll("\0", "\uFFFD");
  const indexOf = String.prototype.indexOf;
  let searched = 0;
  const spy = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, needle: string, from = 0) {
      const found = indexOf.call(this, needle, from),
        text = String(this);
      if (
        (text === source || text === normalized) &&
        needle.startsWith("\uFFFD")
      )
        searched += (found < 0 ? text.length : found + needle.length) - from;
      return found;
    });
  let drawings = 0;
  try {
    drawings = indexMessage(source, { singleDollar: true }).drawn.length;
  } finally {
    spy.mockRestore();
  }
  expect(searched).toBeGreaterThanOrEqual(source.length / 2);
  expect(searched).toBeLessThanOrEqual(8 * source.length);
  expect(drawings).toBe(1);
});

it("stops decoded-line searches when a synthesized GFM node has no source projection", () => {
  const source =
    String.raw`https\://example.test` +
    "\n" +
    Array.from({ length: 512 }, (_, i) => `projection-miss-${i}`).join("\n");
  const indexOf = String.prototype.indexOf;
  let calls = 0;
  const spy = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, needle: string, from = 0) {
      if (String(this) === "" && needle.startsWith("projection-miss-")) calls++;
      return indexOf.call(this, needle, from);
    });
  try {
    expect(
      hostSegments(source).filter((text) => text.startsWith("projection-miss-"))
        .length,
    ).toBe(512);
  } finally {
    spy.mockRestore();
  }
  expect(calls).toBeLessThanOrEqual(1);
});
