// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as drawing from "./render";
import { hostSegments, indexMessage, insideMath, unclosedMath } from "./detect";
import { required } from "../required";
const on = { singleDollar: true };
const index = (content: string) => indexMessage(content, on);

describe("footnote literal and alias policy", () => {
  it.each(["$$x[^n]+y$$", "$a[^n]b$"])(
    "never scans across an independently rendered footnote: %s",
    (body) => {
      const source = `${body}\n\n[^n]: note`,
        result = index(source);
      expect(result.spans).toEqual([]);
      expect(result.drawn).toEqual([]);
      expect(
        hostSegments(source).flatMap((text) => result.pieces(text)),
      ).toEqual([]);
    },
  );
  it("counts a referenced footer as prose when its text equals a body equation", () => {
    const source = "$x$[^n]\n\n[^n]: $x$",
      result = index(source);
    expect(hostSegments(source)).toEqual(["$x$", "$x$"]);
    expect(result.spans.map((span) => span.tex)).toEqual(["x"]);
    expect(result.drawn).toEqual([]);
    expect(result.pieces("$x$")).toEqual([]);
  });
  it("does not invent an alias from an unused definition", () => {
    const source = "$x$\n\n[^unused]: $x$",
      result = index(source);
    expect(hostSegments(source)).toEqual(["$x$"]);
    expect(result.spans.map((span) => span.tex)).toEqual(["x"]);
    expect(result.drawn).toHaveLength(1);
    expect(result.pieces("$x$").map((piece) => piece.role)).toEqual(["render"]);
  });
  it("keeps footer alias decisions invariant under definition order", () => {
    const main = "$x$[^a] $y$[^b]",
      definitions = ["[^a]: $x$", "[^b]: plain"];
    const sources = [definitions, [...definitions].reverse()].map(
      (notes) => `${main}\n\n${notes.join("\n\n")}`,
    );
    const results = sources.map(index);
    // The replica remains in source order; only footer occurrence counts and
    // empty prose signatures participate in mapping, never their order.
    expect(hostSegments(required(sources[0]))).toEqual([
      "$x$",
      " $y$",
      "$x$",
      "plain",
    ]);
    expect(hostSegments(required(sources[1]))).toEqual([
      "$x$",
      " $y$",
      "plain",
      "$x$",
    ]);
    for (const result of results) {
      expect(result.spans.map((span) => span.tex)).toEqual(["x", "y"]);
      expect(result.drawn.map((span) => span.tex)).toEqual(["y"]);
      expect(result.pieces("$x$")).toEqual([]);
    }
    for (const text of ["$x$", " $y$", "plain"])
      expect(required(results[0]).pieces(text)).toEqual(
        required(results[1]).pieces(text),
      );
  });
});

describe("raw-source break ownership", () => {
  it("does not claim the break after prose split off by a punctuation entity", () => {
    const source = "$$x$$&#46; tail\nnext",
      result = index(source);
    expect(result.drawn).toHaveLength(1);
    expect(result.pieces("$$x$$")[0]).toMatchObject({
      joinBefore: true,
      joinAfter: false,
    });
  });
  it("claims an internal break before a unique closing inline render anchor", () => {
    const source = "Before \\(a\n+b\\) one\n\nBefore \\(a\n+c\\) two",
      result = index(source);
    expect(result.drawn).toHaveLength(2);
    for (const text of ["+b) one", "+c) two"])
      expect(result.pieces(text)[0]).toMatchObject({
        role: "render",
        start: 0,
        joinBefore: true,
        joinAfter: false,
      });
    expect(result.pieces("Before (a")[0]).toMatchObject({
      role: "hide",
      joinBefore: false,
      joinAfter: false,
    });
  });
  it.each(["\n", "\r\n", "\r"])(
    "uses physical source lines with %j endings",
    (newline) => {
      const source = ["above", "$$x$$", "below"].join(newline),
        result = index(source);
      expect(result.pieces("$$x$$")[0]).toMatchObject({
        joinBefore: true,
        joinAfter: true,
      });
    },
  );
  it.each([
    "> $$\n> x+y\n> $$",
    "> > $$\n> > x+y\n> > $$",
    "- $$\n  x+y\n  $$",
    "> - $$\n>   x+y\n>   $$",
  ])("ignores only real container prefixes and whitespace: %s", (source) => {
    const result = index(source);
    expect(result.drawn).toHaveLength(1);
    for (const text of hostSegments(source))
      for (const piece of result.pieces(text))
        expect(piece).toMatchObject({ joinBefore: true, joinAfter: true });
  });
  it.each([
    "$$x$$&#46; tail\n\n$$x$$",
    "&#46;$$x$$\n\n$$x$$",
    "$$x$$ and $$x$$",
  ])(
    "refuses identical render aliases with different break classes: %s",
    (source) => {
      const result = index(source);
      expect(result.spans).toHaveLength(2);
      expect(result.drawn).toEqual([]);
      expect(
        hostSegments(source).flatMap((text) => result.pieces(text)),
      ).toEqual([]);
    },
  );
  it.each([
    ["&#46;$$\nx+y\n$$", false, true],
    ["$$\nx+y\n$$&#46; tail", true, false],
    ["*$$\nx+y\n$$*", false, false],
  ] as const)(
    "intersects equivalent hidden aliases without stopping typesetting: %s",
    (source, joinBefore, joinAfter) => {
      const result = index(source);
      expect(result.drawn).toHaveLength(1);
      expect(result.pieces("$$")[0]).toMatchObject({
        role: "hide",
        joinBefore,
        joinAfter,
      });
    },
  );
  it("keeps unambiguous plain display boundaries fully joined", () => {
    const source = "Before\n$$\na\nb\n$$\nafter",
      result = index(source);
    expect(result.drawn).toHaveLength(1);
    for (const text of hostSegments(source))
      for (const piece of result.pieces(text))
        expect(piece).toMatchObject({ joinBefore: true, joinAfter: true });
  });
});

describe("terminal TeX control spaces", () => {
  for (const [open, close] of [
    ["\\(", "\\)"],
    ["\\[", "\\]"],
    ["$$", "$$"],
  ])
    it.each([1, 3])(
      `preserves one terminal control space in ${open}…${close}, slash parity %s`,
      (slashes) => {
        const body = `x${"\\".repeat(slashes)}   `,
          source = open + body + close,
          result = index(source);
        expect(result.spans[0]?.tex).toBe(`x${"\\".repeat(slashes)} `);
        expect(result.spans[0]?.source).toBe(source);
        expect(result.drawn).toHaveLength(1);
        expect(
          drawing.render(
            required(result.spans[0]).tex,
            required(result.spans[0]).display,
          ).ok,
        ).toBe(true);
      },
    );
  it("still removes padding after an even slash run and ordinary control words", () => {
    for (const body of ["x\\\\   ", "\\alpha   ", " x   "])
      expect(index(`\\(${body}\\)`).spans[0]?.tex).toBe(body.trim());
  });
});

describe("per-line raw copy source", () => {
  it("keeps repeated inline equations around a display independent of representative offsets", () => {
    const source = "$x$\n$$\ny\n$$\n$x$",
      result = index(source),
      actual = hostSegments(source);
    expect(result.drawn).toHaveLength(3);
    expect(actual).toEqual(["$x$", "$$", "y", "$$", "$x$"]);
    expect(
      actual.flatMap((text) =>
        result.pieces(text).map((piece) => piece.source),
      ),
    ).toEqual(actual);
    expect(
      actual
        .flatMap((text) => result.pieces(text).map((piece) => piece.source))
        .join("\n"),
    ).toBe(source);
  });
  it.each([
    "> $$\n> x+y\n> $$",
    "> > $$\n> > x+y\n> > $$",
    "- $$\n  x+y\n  $$",
    "> - $$\n>   x+y\n>   $$",
  ])("strips container prefixes from each copied line: %s", (source) => {
    const result = index(source),
      copied = hostSegments(source).flatMap((text) =>
        result.pieces(text).map((piece) => piece.source),
      );
    expect(result.drawn).toHaveLength(1);
    expect(copied).toEqual(["$$", "x+y", "$$"]);
    expect(copied.join("\n")).toBe(result.spans[0]?.source);
  });
  it("copies raw row breaks instead of the host's decoded backslash", () => {
    const source = String.raw`$$
a \\ b
$$`,
      result = index(source),
      actual = hostSegments(source);
    expect(actual).toEqual(["$$", String.raw`a \ b`, "$$"]);
    expect(result.pieces(required(actual[1]))[0]?.source).toBe(
      String.raw`a \\ b`,
    );
    expect(
      actual
        .flatMap((text) => result.pieces(text).map((piece) => piece.source))
        .join("\n"),
    ).toBe(source);
  });
  it("puts an entire raw line on its first unmarked piece, not every same-line fragment", () => {
    const source = String.raw`$$
*a\,b* + y
$$`,
      result = index(source);
    expect(result.drawn).toHaveLength(1);
    expect(result.pieces("a,b")[0]?.source).toBe("");
    expect(result.pieces(" + y")[0]?.source).toBe(String.raw`*a\,b* + y`);
    const grouped = [["$$"], ["a,b", " + y"], ["$$"]].map((line) =>
      line
        .flatMap((text) => result.pieces(text).map((piece) => piece.source))
        .join(""),
    );
    expect(grouped.join("\n")).toBe(result.spans[0]?.source);
  });
  it.each(["*x*", "**x**", "~~x~~"])(
    "uses a marked carrier rather than dropping a formatted line: %s",
    (marked) => {
      const source = `$$\n${marked}\n$$`,
        result = index(source);
      expect(result.spans).toHaveLength(1);
      expect(result.drawn).toHaveLength(1);
      expect(result.pieces("x")[0]?.source).toBe(marked);
    },
  );
  it("also falls back when a physical line has no offered text piece", () => {
    const source = "$$x\n\\\ny$$",
      result = index(source);
    expect(result.spans).toHaveLength(1);
    expect(result.drawn).toEqual([]);
    expect(hostSegments(source).flatMap((text) => result.pieces(text))).toEqual(
      [],
    );
  });
  it("treats different raw copy payloads on identical hide segments as ambiguous", () => {
    const source = "$$\nu\na\n$$\n\n$$\n*a*+b\n$$",
      result = index(source);
    expect(result.spans).toHaveLength(2);
    expect(result.drawn).toEqual([]);
    expect(hostSegments(source).flatMap((text) => result.pieces(text))).toEqual(
      [],
    );
  });
  it.each(["&#10;", "&#13;", "&#xA;", "&NewLine;", "&#10;\n"])(
    "keeps entity-injected host breaks native: %s",
    (entity) => {
      const source = `$$\na${entity}b\n$$`,
        result = index(source);
      expect(result.spans).toHaveLength(1);
      expect(result.drawn).toEqual([]);
      expect(
        hostSegments(source).flatMap((text) => result.pieces(text)),
      ).toEqual([]);
    },
  );
  it.each(["\r\n", "\r"])(
    "normalizes only host-copy line endings, not span.source: %j",
    (eol) => {
      const source = ["$$", "x+y", "$$"].join(eol),
        result = index(source);
      expect(result.drawn).toHaveLength(1);
      expect(result.spans[0]?.source).toBe(source);
      const copied = hostSegments(source).flatMap((text) =>
        result.pieces(text).map((piece) => piece.source),
      );
      expect(copied.join("\n")).toBe("$$\nx+y\n$$");
    },
  );
});

describe("drawn span contract", () => {
  it("retains repeated-line detections for lint but excludes their dropped mappings", () => {
    const result = index("$$\nx\nx\n$$");
    expect(result.spans.map((s) => s.tex)).toEqual(["x\nx"]);
    expect(result.drawn).toEqual([]);
  });
  it.each([
    String.raw`\(\int_{a}^{b} f(x)\,dx\)`,
    String.raw`$$
a\,b \\
\{c\}
$$`,
  ])(
    "keeps decoded-escape equations drawable without raw-line lookups: %s",
    (source) => {
      const result = index(source);
      expect(result.spans).toHaveLength(1);
      expect(result.drawn).toHaveLength(1);
      expect(result.drawn[0]).toBe(result.spans[0]);
      expect(result.drawn[0]?.source).toBe(source);
    },
  );
  it("keeps source order and mapping eligibility separate from syntax validity", () => {
    const result = index("$a$\n\n$$\nx\nx\n$$\n\n$\\notACommand$");
    expect(result.spans.map((s) => s.tex)).toEqual([
      "a",
      "x\nx",
      String.raw`\notACommand`,
    ]);
    expect(result.drawn).toEqual([result.spans[0], result.spans[2]]);
  });
  it("preserves equivalent repeated occurrences rather than deduplicating by segment or TeX", () => {
    const result = index("$x$\n\n$x$");
    expect(result.spans).toHaveLength(2);
    expect(result.drawn).toHaveLength(2);
    expect(result.drawn[0]).toBe(result.spans[0]);
    expect(result.drawn[1]).toBe(result.spans[1]);
  });
  it("returns an empty drawn list on every empty/capped path", () => {
    for (const source of ["ordinary prose", "`$literal$`", "x".repeat(100_001)])
      expect(index(source).drawn).toEqual([]);
  });
});

describe("review regressions", () => {
  it("keeps concealed TeX out of a drawing outside the spoiler", () => {
    const source = "$$x + ||hidden|| + y$$";
    const result = index(source);
    expect(result.spans).toEqual([]);
    expect(
      ["$$x + ", "hidden", " + y$$"].flatMap((s) => result.pieces(s)),
    ).toEqual([]);
  });
  it("anchors complete copy source outside formatting introduced inside TeX", () => {
    const result = index("$$\n*a\\,b* + y\n$$");
    expect(result.pieces("a,b")[0]?.role).toBe("hide");
    expect(result.pieces(" + y")[0]?.role).toBe("render");
    expect(result.pieces(" + y")[0]?.span.tex).toBe(String.raw`*a\,b* + y`);
  });
  it("does not inherit formatting that ends halfway through the equation", () => {
    const result = index("*before $a* + b$");
    expect(result.pieces("before $a")[0]?.role).toBe("hide");
    expect(result.pieces(" + b$")[0]?.role).toBe("render");
  });
  it("scans a no-math body once, not once per host fragment", () => {
    const source = "ordinary negative-cache corpus line\n".repeat(1000);
    const original = RegExp.prototype.test;
    let scans = 0;
    const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
      this: RegExp,
      value: string,
    ) {
      if (value === source) scans++;
      return original.call(this, value);
    });
    try {
      for (let i = 0; i < 20; i++) expect(index(source).spans).toEqual([]);
      expect(scans).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("handles a near-cap backslash run in bounded time with correct parity", () => {
    const source = `${"\\".repeat(80_000)} $x$`;
    const start = performance.now();
    expect(index(source).spans.map((s) => s.tex)).toEqual(["x"]);
    // Generous whole-parser budget; the old quadratic backward walk takes
    // several seconds here. Timing evidence is also recorded separately.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("pass-14 consistency", () => {
  it.each(["before\0 $x$ after", "\0 first\n\0 $x$"])(
    "projects NUL to the parser's replacement character, with raw offsets: %j",
    (source) => {
      const result = index(source),
        text = required(
          hostSegments(source).find((text) => text.includes("$x$")),
        );
      expect(text).toContain("\uFFFD");
      expect(result.drawn).toHaveLength(1);
      const piece = required(result.pieces(text)[0]);
      expect(text.slice(piece.start, piece.end)).toBe("$x$");
      expect(piece.span.start).toBe(source.indexOf("$x$"));
      expect(piece.source).toBe("$x$");
    },
  );
  it("does not rewrite raw TeX when projecting parser-normalized text", () => {
    const source = "$$a\0+b$$",
      result = index(source);
    expect(result.spans[0]?.tex).toBe("a\0+b");
    expect(result.spans[0]?.source).toBe(source);
  });
  it.each([
    "$$\nx\n$$\n\n$$\nx\n$$",
    "$$\nx\n$$\n\n$$\nx\n$$\n\n$$\nx\n$$",
    "**$$\nx\n$$**\n\n**$$\nx\n$$**",
  ])(
    "chooses repeated display bodies without a new mapping pass: %s",
    (source) => {
      const result = index(source);
      expect(result.drawn).toHaveLength(result.spans.length);
      expect(result.drawn.length).toBeGreaterThanOrEqual(2);
      expect(result.pieces("x")[0]?.role).toBe("render");
      expect(result.pieces("$$").every((piece) => piece.role === "hide")).toBe(
        true,
      );
    },
  );
  it.each([
    String.raw`a&=\verb|\begin{align}|`,
    String.raw`a&=\verb*|\begin{align}|`,
    String.raw`a&=\verb|\end{align}|`,
    `% \\end{align}\n${String.raw`a&=\verb*|\begin{align}|`}`,
  ])(
    "ignores complete verbatim bodies in the existing lexer range list: %s",
    (body) => {
      const source = `\\begin{align}\n${body}\n\\end{align}`,
        result = index(source);
      expect(drawing.render(source, true).ok).toBe(true);
      expect(result.spans.map((span) => span.source)).toEqual([source]);
      expect(result.drawn).toHaveLength(1);
      expect(unclosedMath(source)).toEqual([]);
      expect(insideMath(source)).toBe(false);
    },
  );
  it("does not close completion or diagnostics on a verbatim-only closer", () => {
    const source = `\\begin{align}\na&=${String.raw`\verb|\end{align}|`}`;
    expect(index(source).spans).toEqual([]);
    expect(unclosedMath(source)).toEqual([{ delimiter: "env", start: 0 }]);
    expect(insideMath(source)).toBe(true);
  });
  it.each(["\r", "\r\n", "\n"])(
    "uses the next physical line boundary after an environment: %j",
    (newline) => {
      const equation = "\\begin{equation}x=y\\end{equation}",
        source = `${equation + newline}After`;
      expect(index(source).drawn.map((span) => span.source)).toEqual([
        equation,
      ]);
    },
  );
  it("keeps CR-only multiline environments separate from following prose", () => {
    const equation = "\\begin{align}\ra&=b\r\\end{align}",
      result = index(`${equation}\rAfter`);
    expect(result.drawn.map((span) => span.source)).toEqual([equation]);
  });
  it.each(["After", "`After`", "[After](https://example.test)"])(
    "still refuses prose/literals on the closing line: %s",
    (suffix) => {
      expect(
        index(`\\begin{equation}x=y\\end{equation} ${suffix}`).spans,
      ).toEqual([]);
    },
  );
  it("keeps the declined formatted bare environment native, with a dollar alternative", () => {
    expect(
      index(String.raw`**\begin{equation}x=1\end{equation}**`).drawn,
    ).toEqual([]);
    expect(index("**$$x=1$$**").drawn).toHaveLength(1);
  });
});

describe("decoded bare-link fallback", () => {
  it.each([
    String.raw`http\://localhost:3000`,
    String.raw`https\://my-host:3000`,
    String.raw`HTTPS\://localhost`,
    "abchttps&colon;//example.test",
  ])(
    "keeps every equation piece native when decoded prose becomes a host link: %s",
    (url) => {
      const body = `${url} $$\nx+y\n$$`;
      for (const source of [body, `${body}\n\n $$\na+b\n$$`]) {
        const result = index(source);
        expect(result.spans).toHaveLength(source === body ? 1 : 2);
        expect(result.drawn).toEqual([]);
        // Actual host fragments, including ones the replica does not offer.
        for (const text of [" $$", "x+y", "$$", "a+b", ...hostSegments(source)])
          expect(result.pieces(text)).toEqual([]);
      }
      expect(insideMath(`${url} $$\nx+y\n`)).toBe(false);
      expect(insideMath(`${url}\n\n~~~math\n\\alp`)).toBe(true);
    },
  );
  it.each([
    "https://example.com",
    "http://example.com",
    "<https://example.com>",
    "[docs](https://example.com)",
  ])("keeps ordinary literal/GFM links beside math drawable: %s", (url) => {
    const source = `see ${url} for $x$\n$$\ny\n$$`,
      result = index(source);
    expect(result.drawn).toHaveLength(2);
    expect(hostSegments(source).some((text) => /https?:\/\//i.test(text))).toBe(
      false,
    );
    expect(insideMath(`see ${url} \\(`)).toBe(true);
  });
  it("does not expand the fallback to schemes the host does not split", () => {
    expect(
      index(`${String.raw`ftp\://example.test $$`}\nx+y\n$$`).drawn,
    ).toHaveLength(1);
  });
});

describe("bare-environment comment balancing", () => {
  it.each([
    "\\begin{align}\n% \\begin{align}\na &= b\n\\end{align}",
    "\\begin{align*}\n% \\begin{align*}\na &= b\n\\end{align*}",
    "\\begin{align}\n% \\end{align}\na &= b\n\\end{align}",
    "\\begin{align}\r\n% \\begin{align}\r\na &= b\r\n\\end{align}",
    "\\begin{align}\na&=b\n% \\begin{align}\rc&=d\n\\end{align}",
    "\\begin{align}\na&=b\n% comment\r\\end{align}\nc&=d\n\\end{align}",
    "\\begin{align}\na&=b \\\\% \\begin{align}\nc&=d\n\\end{align}",
  ])(
    "ignores commented environment tokens while preserving raw source: %s",
    (source) => {
      const result = index(source);
      expect(result.spans.map((span) => span.source)).toEqual([source]);
      expect(result.drawn).toHaveLength(1);
      expect(drawing.render(required(result.spans[0]).tex, true).ok).toBe(true);
      expect(unclosedMath(source)).toEqual([]);
      expect(insideMath(source)).toBe(false);
    },
  );
  it("resumes comment discovery after non-TeX prose between bare environments", () => {
    const source =
      "\\begin{equation}a\\end{equation}\nmention \\verb command\n\\begin{align}\n% \\begin{align}\na&=b\n\\end{align}";
    expect(index(source).drawn).toHaveLength(2);
    expect(unclosedMath(source)).toEqual([]);
    expect(insideMath(source)).toBe(false);
  });
  it("does not close math or completion at a commented EOF closer", () => {
    const source = "\\begin{align}\na &= b\n% \\end{align}";
    expect(index(source).spans).toEqual([]);
    expect(unclosedMath(source)).toEqual([{ delimiter: "env", start: 0 }]);
    expect(insideMath(source)).toBe(true);
  });
  it.each([String.raw`\%`, String.raw`\\\%`, String.raw`\verb|%|`])(
    "does not turn an escaped/verbatim percent into a comment: %s",
    (literal) => {
      const source = `\\begin{align}\na &= b\n${literal} \\end{align}`;
      expect(drawing.render(source, true).ok).toBe(true);
      expect(index(source).spans.map((span) => span.source)).toEqual([source]);
      expect(insideMath(source)).toBe(false);
    },
  );
});

describe("pass-4 regressions", () => {
  const references = { names: [], channels: [], emoji: ["party"] };
  it.each(["$$\\text{:party:}\nx+y\n$$", "$$\nx+:PARTY:\n$$"])(
    "drops every piece, not just the anchor, on an emoji conflict: %s",
    (source) => {
      const result = indexMessage(source, { ...on, references });
      expect(result.spans).toHaveLength(1);
      expect(result.drawn).toEqual([]);
      expect(
        hostSegments(source, references).flatMap((text) => result.pieces(text)),
      ).toEqual([]);
    },
  );
  it("preserves nonoverlapping math, exact entry casing and cache isolation", () => {
    expect(
      indexMessage(":party: $x$", { ...on, references }).drawn.map(
        (s) => s.tex,
      ),
    ).toEqual(["x"]);
    const source = "$$\\text{:party:}\nx+y\n$$";
    const plain = indexMessage(source, {
      ...on,
      references: { names: [], channels: [] },
    });
    for (const emoji of [[], ["PARTY"], ["other"]])
      expect(
        indexMessage(source, {
          ...on,
          references: { names: [], channels: [], emoji },
        }).drawn,
      ).toHaveLength(1);
    expect(indexMessage(source, { ...on, references }).drawn).toEqual([]);
    expect(plain.drawn).toHaveLength(1);
  });
  it("keeps a whole bare-Buzz body readable, including aliases in another paragraph", () => {
    const source = "buzz://channel/general $$\nx+y\n$$\n\n $$\na+b\n$$",
      result = index(source);
    expect(result.spans).toHaveLength(2);
    expect(result.drawn).toEqual([]);
    for (const text of [" $$", "x+y", "$$", "a+b"])
      expect(result.pieces(text)).toEqual([]);
    expect(insideMath("buzz://channel/general \\(")).toBe(false);
    expect(insideMath("buzz://channel/general\n\n```math\n\\alp")).toBe(true);
  });
  // Preserve high-cardinality semantics; range-work.test.ts budgets entity, unresolved-reference,
  // and spoiler-container work directly.
  it("indexes many entity containers", () => {
    for (const prefix of ["A", "B"])
      expect(
        index(`${prefix}\n\n${"&#58;\n\n".repeat(14_000)}$z$`).drawn.map(
          (s) => s.tex,
        ),
      ).toEqual(["z"]);
  });
  it("indexes many unresolved-reference containers", () => {
    expect(
      indexMessage(`${"@a\n\n".repeat(24_999)}$z$`, {
        ...on,
        references: { names: [], channels: [] },
      }).drawn.map((s) => s.tex),
    ).toEqual(["z"]);
  });
  it("indexes many spoiler containers", () => {
    expect(
      index(`${"||x||\n\n".repeat(14_000)}$z$`).drawn.map((s) => s.tex),
    ).toEqual(["z"]);
  });
});

describe("pass-3 regressions", () => {
  it("keeps the display after a protected punctuation entity drawable on real host segments", () => {
    const source = "Contact a&#64;b.com: $$\nx+y\n$$",
      result = index(source);
    const actual = ["Contact a", "b.com: $$", "x+y", "$$"];
    expect(hostSegments(source)).toEqual(actual);
    const pieces = actual.flatMap((text) => result.pieces(text));
    expect(pieces.map((piece) => piece.role)).toEqual([
      "render",
      "hide",
      "hide",
    ]);
    expect(result.drawn.map((span) => span.source)).toEqual(["$$\nx+y\n$$"]);
  });
  it("maps many LF-only segments without quadratic line-start searches", () => {
    // Cheap literal separators isolate mapping from GFM's emphasis-parser cost.
    // Distinct bodies keep both near-cap passes uncached; neither contains CR.
    const start = performance.now();
    for (let i = 0; i < 2; i++) {
      const source = `${i}\n${"x<a>".repeat(24_998)} $$`;
      expect(index(source).spans).toEqual([]);
      expect(insideMath(source)).toBe(true);
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
  it("bounds nested unterminated environment headers near the size cap", () => {
    // End-header starts isolate token scanning from the separate begin-line guard.
    const source = `\\begin{align}\n\\begin{${"\\end{".repeat(19_598)}`,
      start = performance.now();
    expect(index(source).spans).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(unclosedMath(source)).toEqual([{ delimiter: "env", start: 0 }]);
    expect(insideMath(source)).toBe(true);
  });
  it("does not promote a literal cut to a bare-environment line start", () => {
    expect(index("&#58;\\begin{align}\nx=y\n\\end{align}").spans).toEqual([]);
    expect(
      index("&#58;\n\\begin{align}\nx=y\n\\end{align}").drawn.map(
        (span) => span.delimiter,
      ),
    ).toEqual(["env"]);
  });
  it("balances starred environments and nested letter-name headers without crossing literal cuts", () => {
    const source = String.raw`\begin{align*}
x &= \begin{matrix}a & b\end{matrix}
\end{align*}`;
    expect(index(source).spans.map((span) => span.source)).toEqual([source]);
    expect(index("\\begin{align}\n`\\end{align}`").spans).toEqual([]);
  });
});

describe("outer-format copy safety", () => {
  it.each([
    String.raw`**$x_i$**`,
    String.raw`**$a\,b$**`,
    String.raw`**\(x\)**`,
    String.raw`*\[x\]*`,
    String.raw`~~$x_i$~~`,
    String.raw`*$\frac{a}{b}$*`,
    "*$$\nx+y\n$$*",
  ])(
    "renders math inside bold, italic and strike-through wrappers: %s",
    (source) => {
      const result = index(source);
      expect(result.drawn).toHaveLength(1);
      expect(
        hostSegments(source)
          .flatMap((text) => result.pieces(text))
          .filter((piece) => piece.role === "render"),
      ).toHaveLength(1);
    },
  );
  it.each([
    String.raw`||$x_i$||`,
    String.raw`||\(x\)||`,
    String.raw`**||$x$||**`,
    String.raw`||**$x$**||`,
  ])("keeps concealed math inside spoilers native: %s", (source) => {
    const result = index(source);
    expect(result.spans).toHaveLength(1);
    expect(result.drawn).toEqual([]);
    expect(
      hostSegments(source).flatMap((segment) => result.pieces(segment)),
    ).toEqual([]);
  });
  it.each([
    String.raw`$x_i$`,
    String.raw`$a\,b$`,
    String.raw`\(x\)`,
    String.raw`\[x\]`,
    String.raw`$a*b*c$`,
    String.raw`||secret|| then $x_i$`,
  ])(
    "keeps unformatted controls and available unformatted anchors: %s",
    (source) => {
      const result = index(source);
      expect(result.drawn).toHaveLength(1);
      expect(
        hostSegments(source)
          .flatMap((segment) => result.pieces(segment))
          .filter((p) => p.role === "render"),
      ).toHaveLength(1);
    },
  );
});

describe("reference context and cache", () => {
  it("re-indexes when a recipient name arrives, without mutating either index", () => {
    const source = "@Ana see $E=mc^2$";
    const missing = indexMessage(source, {
      ...on,
      references: { names: [], channels: [] },
    });
    const ready = indexMessage(source, {
      ...on,
      references: { names: ["Ana"], channels: [] },
    });
    expect(missing.spans).toEqual([]);
    expect(ready.spans).toHaveLength(1);
    expect(ready.pieces(" see $E=mc^2$")[0]).toMatchObject({
      start: 5,
      end: 13,
      role: "render",
    });
    expect(
      indexMessage(source, { ...on, references: { names: [], channels: [] } }),
    ).toBe(missing);
    expect(missing.pieces("@Ana see $E=mc^2$")).toEqual([]);
  });
  it("preserves raw offsets and standalone copy source beside a multiline mention", () => {
    const source = "@Mira here's the result: $$\nx^2\n$$";
    const result = indexMessage(source, {
      ...on,
      references: { names: ["Mira"], channels: [] },
    });
    expect(result.spans[0]).toMatchObject({
      start: source.indexOf("$$"),
      end: source.length,
      tex: "x^2",
      source: "$$\nx^2\n$$",
    });
    const pieces = hostSegments(source, {
      names: ["Mira"],
      channels: [],
    }).flatMap((s) => result.pieces(s));
    expect(pieces.map((p) => p.role)).toEqual(["render", "hide", "hide"]);
  });
  it("never lets a missing or ambiguous name's paragraph affect a different one", () => {
    const source = "@Ana $x$\n\n$y$";
    for (const names of [[], ["Ana", "Ana"]])
      expect(
        indexMessage(source, {
          ...on,
          references: { names, channels: [] },
        }).spans.map((s) => s.tex),
      ).toEqual(["y"]);
    expect(
      indexMessage(source, {
        ...on,
        references: { names: ["Ana"], channels: [] },
      }).spans.map((s) => s.tex),
    ).toEqual(["x", "y"]);
  });
});

describe("shared draft lexer end state", () => {
  const yes = [
    String.raw`$\alp`,
    String.raw`see $x + \alp`,
    "$$\n\\int \\alp",
    String.raw`\(a \alp`,
    "\\[\n\\alp",
    "```math\n\\alp",
    "\\begin{align}\nx &= \\alp",
    String.raw`$5 and $\alp`,
    String.raw`$a $\alp`,
  ];
  const no = [
    String.raw`\alp`,
    String.raw`costs $ 5 \alp`,
    String.raw`$x$ then \alp`,
    String.raw`$$x$$ \alp`,
    String.raw`\(x\) \alp`,
    "`$code` \\alp",
    "```python\n$\\alp",
    "```math\nx\n```\n\\alp",
    "$a\n\n\\alp",
    "$a\n\\alp",
    String.raw`\$ \alp`,
  ];
  it.each(yes)("is inside math at the caret: %s", (before) =>
    expect(insideMath(before)).toBe(true),
  );
  it.each(no)("is outside math at the caret: %s", (before) =>
    expect(insideMath(before)).toBe(false),
  );
  it.each([
    "~~~tex\n\\alp",
    "````LaTeX\n\\alp\n```",
    "> ```math\n> \\alp",
    "- ```katex\n  \\alp",
  ])("recognizes an unclosed supported fence: %s", (before) =>
    expect(insideMath(before)).toBe(true),
  );
  it.each([
    "~~~math\nx\n~~~",
    "````math\nx\n````",
    "> ```math\n> x\n> ```",
    "`$x$`",
    "[$x$](https://example.test)",
    "<div>\n$x$",
    "$a\n",
    "$$a\n\n",
    "\\[a\r\n\r\n",
  ])("ends outside math in a literal or new paragraph: %s", (before) =>
    expect(insideMath(before)).toBe(false),
  );
  it.each([
    String.raw`see \[1] and $x^2$`,
    String.raw`array \(a and $x^2$`,
    "$$ total and $x^2$",
  ])("resumes prose after an unclosed opener: %s", (before) => {
    expect(index(before).spans.map((span) => span.tex)).toEqual(["x^2"]);
    expect(unclosedMath(before)).toHaveLength(1);
    expect(insideMath(before)).toBe(true);
  });
  it("returns lexer openers rather than counting delimiter parity", () => {
    expect(unclosedMath("$$x$$\n\n\\[y")).toEqual([
      { delimiter: "\\[", start: 7 },
    ]);
    expect(unclosedMath("\\(x")).toEqual([{ delimiter: "\\(", start: 0 }]);
    expect(unclosedMath("\\begin{align}\nx")).toEqual([
      { delimiter: "env", start: 0 },
    ]);
    expect(unclosedMath("`$$`")).toEqual([]);
    expect(insideMath("plain text")).toBe(false);
    expect(insideMath(`$${"x".repeat(100_000)}`)).toBe(false);
  });
});

describe("math detection", () => {
  const currency = [
    "$5 and $10",
    "costs $5, or $6",
    "$5-$10",
    "I owe $1.20 and $2.50.",
    "USD $100, CAD $125",
    "Spend $20\nSave $30",
    "A price of $5.",
    "The total is $0",
    String.raw`\$5 and \$10`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: A literal shell-style placeholder is the test input.
    "${HOME} and $PATH",
    "$ x$",
    "$x $",
    "$x$2",
    "$$",
    "$$ $$",
    "$a\nb$",
  ];
  it.each(currency)("does not typeset money/invalid dollars: %s", (text) =>
    expect(index(text).spans).toEqual([]),
  );
  it.each([
    [String.raw`$\alpha $`, String.raw`\alpha`],
    [String.raw`$x + \beta $ ok`, String.raw`x + \beta`],
    [
      String.raw`see $\frac{a}{b} \cdot \pi $.`,
      String.raw`\frac{a}{b} \cdot \pi`,
    ],
  ])(
    "accepts host completion spaces after a control word: %s",
    (source, tex) => {
      expect(index(source).spans.map((span) => span.tex)).toEqual([tex]);
    },
  );
  it("does not extend the control-word exception to ordinary trailing space or a following digit", () => {
    for (const source of ["$x $", "$5 and $10", String.raw`$\alpha $5`])
      expect(index(source).spans).toEqual([]);
  });
  it("takes raw TeX, preserves escapes, trims only the TeX edges", () => {
    const text = String.raw`before \( a\,b\{c\}\\d \) after`;
    expect(index(text).spans).toEqual([
      {
        start: 7,
        end: text.length - 6,
        source: text.slice(7, -6),
        tex: String.raw`a\,b\{c\}\\d`,
        delimiter: "\\(",
        display: false,
      },
    ]);
  });
  it.each(["$a*b*c$", "$a**b**c$", "$a~~b~~c$"])(
    "scans through emphasis: %s",
    (source) => {
      const result = index(source);
      expect(result.spans[0]?.source).toBe(source);
      const pieces = hostSegments(source).flatMap((s) => result.pieces(s));
      expect(pieces.filter((p) => p.role === "render")).toHaveLength(1);
      expect(pieces).toHaveLength(3);
    },
  );
  it.each([
    "$$\na+b\\\\\nc+d\n$$",
    "\\[\na+b\n\\]",
    "> $$\n> x+y\n> $$",
    "- $$\n  x+y\n  $$",
  ])("maps a multiline span: %s", (source) => {
    const result = index(source);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.display).toBe(true);
    const pieces = hostSegments(source).flatMap((s) => result.pieces(s));
    expect(pieces.filter((p) => p.role === "render")).toHaveLength(1);
    expect(pieces.some((p) => p.role === "hide")).toBe(true);
  });
  it.each([
    ["> $$\n> x+y\n> $$", "x+y"],
    ["> > $$\n> > a\\,b\\{c\\}\\\\d\n> > $$", String.raw`a\,b\{c\}\\d`],
    ["- $$\n  x+y\n  $$", "x+y"],
    ["> - $$\n>   x+y\n>   $$", "x+y"],
    ["10. $$\n    x+y\n    $$", "x+y"],
    ["> $$\n> *x*+y\n> $$", "*x*+y"],
  ])(
    "removes continuation prefixes from TeX and copy source, retaining raw offsets: %s",
    (source, tex) => {
      const span = required(index(source).spans[0]);
      expect(span.tex).toBe(tex);
      expect(span.source).toBe(`$$\n${tex}\n$$`);
      expect(span.start).toBe(source.indexOf("$$"));
      expect(span.end).toBe(source.lastIndexOf("$$") + 2);
    },
  );
  it("does not cross paragraphs or skipped literal nodes", () => {
    for (const source of [
      "$$\n\nx+y\n\n$$",
      "$a `code` b$",
      "$a [link](https://example.test) b$",
      "`$x$`",
      "```math\nx+y\n```",
      "    $x$",
      "[$x$](https://example.test)",
      "<div>\n$x$\n</div>",
    ])
      expect(index(source).spans, source).toEqual([]);
  });
  it("supports headings, lists, GFM tables, and chemistry as raw source", () => {
    const source =
      "# $x$\n\n- $y$\n\n| A | B |\n|---|---|\n| $z$ | \\(\\ce{H2O}\\) |";
    expect(index(source).spans.map((s) => s.tex)).toEqual([
      "x",
      "y",
      "z",
      "\\ce{H2O}",
    ]);
  });
  it("respects escaped delimiters and the singleDollar option", () => {
    expect(index(String.raw`\$x\$ \\(a\\) \\[b\\]`).spans).toEqual([]);
    expect(
      indexMessage("$x$ $$y$$ \\(z\\)", { singleDollar: false }).spans.map(
        (s) => s.tex,
      ),
    ).toEqual(["y", "z"]);
    expect(index("$$x$$").spans).toHaveLength(1);
  });
  it("balances same-name bare environments, with line-boundary guards", () => {
    const source =
      "\\begin{align}\na&=b\n\\begin{align}c&=d\\end{align}\n\\end{align}";
    expect(index(source).spans.map((s) => [s.tex, s.delimiter])).toEqual([
      [source, "env"],
    ]);
    expect(index("text \\begin{align}a&=b\\end{align}").spans).toEqual([]);
    expect(index("\\begin{align}a&=b\\end{align} text").spans).toEqual([]);
    expect(index("\\begin{unknown}x\\end{unknown}").spans).toEqual([]);
  });
  it("preserves UTF-16 source and segment offsets for escaped punctuation and entities", () => {
    const source = String.raw`😀 pre $a\,b &lt; c$ tail`;
    const result = index(source);
    const segment = required(hostSegments(source)[0]);
    const piece = required(result.pieces(segment)[0]);
    const first = required(result.spans[0]);
    expect(source.slice(first.start, first.end)).toBe(
      String.raw`$a\,b &lt; c$`,
    );
    expect(segment.slice(piece.start, piece.end)).toBe("$a,b < c$");
    expect(piece.start).toBe(7);
  });
  it("prefers a unique anchor, makes other multiline pieces hide", () => {
    const result = index("$$\nx+y\n$$");
    expect(result.pieces("x+y")[0]?.role).toBe("render");
    expect(result.pieces("$$")[0]?.role).toBe("hide");
  });
  it("drops ambiguous mappings, retains detected spans, leaves prose untouched", () => {
    const result = index("$$\nx\n$$\n\nx");
    expect(result.spans).toHaveLength(1);
    for (const text of ["$$", "x", "unknown"])
      expect(result.pieces(text)).toEqual([]);
  });
  it.each([
    ["$$\nx\n$$\n\n$$\ny\n$$", "x", "y"],
    ["First:\n$$\na+b\n$$\nthen\n$$\nc+d\n$$", "a+b", "c+d"],
    ["\\[\nx\n\\]\n\n\\[\ny\n\\]", "x", "y"],
  ])(
    "renders distinct displays sharing hidden delimiter lines: %s",
    (source, first, second) => {
      const result = index(source);
      expect(result.spans).toHaveLength(2);
      expect(result.pieces(first)[0]?.role).toBe("render");
      expect(result.pieces(second)[0]?.role).toBe("render");
      for (const text of hostSegments(source))
        if (text === "$$" || text === "[" || text === "]")
          expect(result.pieces(text)[0]?.role).toBe("hide");
    },
  );
  it.each([false, true])(
    "rejects hide aliases across valid and invalid explicit spans, reversed=%s",
    (reversed) => {
      const blocks = ["$$\na\nx\n\\notacommand\n$$", "$$\nb\nx\n$$"];
      const source = (reversed ? blocks.reverse() : blocks).join("\n\n"),
        result = index(source);
      expect(result.spans).toHaveLength(2);
      expect(result.drawn).toEqual([]);
      for (const text of hostSegments(source))
        expect(result.pieces(text)).toEqual([]);
    },
  );
  it("also compares hide outcomes for equal substrings inside a single segment", () => {
    const source = String.raw`$$\notacommand *$$ and $$* b$$`,
      result = index(source);
    expect(hostSegments(source)).toEqual([
      "$$\\notacommand ",
      "$$ and $$",
      " b$$",
    ]);
    expect(result.spans).toHaveLength(2);
    expect(result.drawn).toEqual([]);
    for (const text of hostSegments(source))
      expect(result.pieces(text)).toEqual([]);
  });
  it("keeps equal successful hide substrings inside a single segment", () => {
    expect(index("$$a *$$ and $$* b$$").drawn).toHaveLength(2);
  });
  it("compares actual inline/display outcomes even for identical TeX", () => {
    const source = "\\(\nx\n\\tag{1}\n\\)\n\n\\[\nx\n\\tag{1}\n\\]",
      result = index(source);
    expect(result.spans.map((span) => [span.tex, span.display])).toEqual([
      ["x\n\\tag{1}", false],
      ["x\n\\tag{1}", true],
    ]);
    expect(result.drawn).toEqual([]);
    for (const text of hostSegments(source))
      expect(result.pieces(text)).toEqual([]);
  });
  it("drops failed explicit hide aliases with different error messages", () => {
    const source = "$$\na\nx\n\\notacommand\n$$\n\n$$\nb\nx\n\\otherbad\n$$",
      result = index(source);
    expect(result.spans).toHaveLength(2);
    expect(result.drawn).toEqual([]);
    for (const text of hostSegments(source))
      expect(result.pieces(text)).toEqual([]);
  });
  it("allows failed explicit hide aliases with the same error message", () => {
    const source =
        "$$\na\nx\n\\notacommand\n$$\n\n$$\nlonger\nx\n\\notacommand\n$$",
      result = index(source);
    expect(result.drawn).toHaveLength(2);
    expect(result.pieces("x")).toMatchObject([{ role: "hide", source: "x" }]);
  });
  it("allows successful dollar and explicit hide aliases", () => {
    const tex = "a*b*c",
      source = `$${tex}$\n\n\\(${tex}\\)`,
      result = index(source);
    expect(result.drawn).toHaveLength(2);
    expect(result.pieces("b")).toMatchObject([{ role: "hide", source: "" }]);
  });
  it("retains the failed-dollar versus failed-explicit hide distinction", () => {
    const tex = String.raw`a*b\notacommand*c`,
      source = `$${tex}$\n\n\\(${tex}\\)`,
      result = index(source);
    expect(result.spans.map((span) => span.tex)).toEqual([tex, tex]);
    expect(result.drawn).toEqual([]);
    for (const text of hostSegments(source))
      expect(result.pieces(text)).toEqual([]);
  });
  it.each([
    "lazy-single $$x_q$$",
    "lazy-multiline\n$$\nx_q\n$$",
    "\\[\nu\na\n\\]\n\n$$\n*a*+b\n$$",
  ])(
    "does not render without a same-source hide collision across spans: %s",
    (source) => {
      const spy = vi.spyOn(drawing, "render");
      try {
        index(source);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );
  it("memoizes the exact UI render call once per colliding span", () => {
    const spy = vi.spyOn(drawing, "render");
    try {
      const result = index("lazy-pair\n$$\nx_q\n$$\n\n$$\ny_q\n$$");
      expect(result.drawn).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls).toEqual(
        expect.arrayContaining([
          ["x_q", true, { fleqn: true }],
          ["y_q", true, { fleqn: true }],
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps equivalent hide pieces and unique render anchors eligible", () => {
    const source = "A: $$\nx\n$$\n\nB: $$\nx\n$$",
      result = index(source);
    expect(result.drawn).toHaveLength(2);
    expect(result.pieces("x")).toMatchObject([{ role: "hide", source: "x" }]);
    expect(result.pieces("$$")).toMatchObject([{ role: "hide", source: "$$" }]);
  });
  it.each(["$$x$$\n\n$$y$$", "$$\na\n$$\n\n\\[\nb\n\\]"])(
    "keeps distinct displays when their pieces do not alias: %s",
    (source) => {
      expect(index(source).drawn).toHaveLength(2);
    },
  );
  it("can render identical repeated spans when all occurrences have identical lists", () => {
    const result = index("$x$\n\n$x$");
    expect(result.spans).toHaveLength(2);
    expect(result.pieces("$x$")).toMatchObject([
      { start: 0, end: 3, role: "render" },
    ]);
  });
  it("drops non-equivalent pieces with the same decoded match inside a segment", () => {
    const source = `${String.raw`$\{x\}$`} and \${x}$`;
    const result = index(source);
    expect(result.spans.map((span) => span.tex)).toEqual([
      String.raw`\{x\}`,
      "{x}",
    ]);
    expect(result.pieces(required(hostSegments(source)[0]))).toEqual([]);
  });
  it("keeps equivalent repeated matches in one segment", () => {
    const source = "$x$ and $x$",
      result = index(source);
    expect(result.pieces(source).map((piece) => piece.role)).toEqual([
      "render",
      "render",
    ]);
  });
  it("uses dollar-hide TeX identity and drops all pieces of conflicting spans", () => {
    const source = `${String.raw`$a*b*c$`}\n\n${String.raw`$x*b\bad*c$`}`;
    const result = index(source);
    expect(hostSegments(source).filter((text) => text === "c$")).toHaveLength(
      2,
    );
    expect(result.spans).toHaveLength(2);
    for (const segment of hostSegments(source))
      expect(result.pieces(segment)).toEqual([]);
  });
  it("retains a whole unsplit invalid span for fallback in the exact review example", () => {
    const source = `${String.raw`$a*b*c$`}\n\n${String.raw`$x*\bad*c$`}`;
    const result = index(source),
      segment = required(hostSegments(source).at(-1));
    expect(result.pieces(segment)).toMatchObject([
      { start: 0, end: segment.length, role: "render" },
    ]);
  });
  it("keeps single-line source byte-exact", () => {
    const source = String.raw`before \( a\,b \) after`;
    const result = required(index(source).spans[0]);
    expect(result.source).toBe(source.slice(result.start, result.end));
  });
  it("returns ordered non-overlapping ranges and immutable cached results", () => {
    const result = index("a $x$ b $y$ c");
    const pieces = result.pieces("a $x$ b $y$ c");
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      [2, 5],
      [8, 11],
    ]);
    expect(Object.isFrozen(result.spans)).toBe(true);
    expect(Object.isFrozen(pieces)).toBe(true);
    expect(index("a $x$ b $y$ c")).toBe(result);
  });
  it("keeps a mixed currency-and-math message from swallowing prices", () => {
    expect(index("$5 and $10, plus $x$").spans.map((s) => s.tex)).toEqual([
      "x",
    ]);
    for (let n = 1; n <= 100; n++)
      for (const text of [
        `$${n} and $${n + 1}`,
        `Cost $${n}.50, not $${n + 2}.99`,
        `$${n}-$${n + 20}`,
      ])
        expect(index(text).spans).toEqual([]);
  });
  it("bounds malformed repeated display openers and environments", () => {
    expect(index("\\(".repeat(10_000)).spans).toEqual([]);
    expect(index("\\begin{align}\n".repeat(2_000)).spans).toEqual([]);
  });
  it("has a shared no-parse fast path, caps input/spans, and bounds the LRU", () => {
    expect(index("plain")).toBe(index("another plain message"));
    expect(index("$".repeat(100_001)).spans).toEqual([]);
    expect(index(Array(550).fill("$x$").join(" ")).spans).toHaveLength(500);
    expect(
      required(index(`$${"x".repeat(10_001)}$`).spans[0]).tex,
    ).toHaveLength(10_001);
    const oldest = index("$oldest$");
    for (let i = 0; i < 256; i++) index(`$x_{${i}}$`);
    expect(index("$oldest$")).not.toBe(oldest);
  });
});

describe("collision-free pre-Markdown protection", () => {
  it.each(["<>", "<\u2010", "<&#8208;"])(
    "does not bind authored spoiler-like reference labels: %s",
    (label) => {
      const source = `[ref ${label}]: https://example.test\n\n[ref ||] $$\nx+y\n$$`,
        result = index(source);
      expect(hostSegments(source)).toEqual([
        "[ref ",
        "||",
        "] $$",
        "x+y",
        "$$",
      ]);
      expect(result.pieces("] $$").map((piece) => piece.role)).toEqual([
        "render",
      ]);
      expect(result.spans.map((span) => span.tex)).toEqual(["x+y"]);
    },
  );
  it.each([
    { name: "Ana", label: "\uFFFC\uE100\uE100\uE100" },
    { name: "Ana!", label: "\uFFFC\uE100\uE100\uE100\uFFFC" },
    { name: "Ana", label: "\u2010\uE000\uE000\uE000" },
  ])(
    "does not bind authored profile-mask labels: $name/$label",
    ({ name, label }) => {
      const source = `[ref ${label}]: https://example.test\n\n[ref @${name}] $$\nx+y\n$$`;
      const references = { names: [name], channels: [] },
        result = indexMessage(source, { ...on, references });
      expect(hostSegments(source, references)).toEqual([
        "[ref ",
        "] $$",
        "x+y",
        "$$",
      ]);
      expect(result.pieces("] $$").map((piece) => piece.role)).toEqual([
        "render",
      ]);
      expect(result.spans.map((span) => span.tex)).toEqual(["x+y"]);
    },
  );
});
it.each([
  "> $$\n> x\n> \\>\n> y\n> $$",
  "> > $$\n> > x\n> > \\>\n> > y\n> > $$",
  "> - $$\n>   x\n>   \\>\n>   y\n>   $$",
  "- $$\n  x\n  \\>\n  y\n  $$",
])(
  "never projects a container marker as the escaped body greater-than: %s",
  (source) => {
    const result = index(source),
      span = required(result.spans[0]);
    expect(result.drawn).toHaveLength(1);
    expect(span.tex).toBe("x\n\\>\ny");
    expect(span.source).toBe("$$\nx\n\\>\ny\n$$");
    expect(source.slice(span.start, span.start + 2)).toBe("$$");
    const body = result.pieces(">");
    expect(body.map((piece) => piece.source)).toEqual(["\\>"]);
    expect(body[0]?.span).toBe(span);
    expect(body[0]).toMatchObject({ joinBefore: true, joinAfter: true });
  },
);
it("keeps entity-produced leading whitespace and raw TeX while excluding quote prefixes", () => {
  const source = "> $$\n> x\n> &#32;z\n> $$",
    result = index(source);
  expect(result.spans[0]?.tex).toBe("x\n&#32;z");
  expect(result.pieces(" z").map((piece) => piece.source)).toEqual(["&#32;z"]);
});

it("stays native when no collision-free punctuation mask remains", () => {
  const punctuation = Array.from({ length: 0x2c00 - 0x2000 }, (_, i) =>
    String.fromCharCode(0x2000 + i),
  )
    .filter((char) => /[\p{P}\p{S}]/u.test(char))
    .join("");
  const source = `${punctuation}\n\n||literal\n\n$$x$$`,
    result = index(source);
  expect(result.spans).toEqual([]);
  expect(result.drawn).toEqual([]);
  expect(result.pieces("$$x$$")).toEqual([]);
});

it("leaves a refused URL environment native when its percent comments the closer", () => {
  const source = "\\begin{align}\na&=b\n\\url{a%20} \\end{align}",
    result = index(source);
  expect(drawing.render(source, true)).toMatchObject({
    ok: false,
    message: "Links, images and HTML commands are not supported",
  });
  expect(result.spans).toEqual([]);
  expect(result.drawn).toEqual([]);
  expect(hostSegments(source).flatMap((text) => result.pieces(text))).toEqual(
    [],
  );
});

it.each([
  { source: "@A||B $x$", names: ["A||B"], segments: [" $x$"] },
  { source: "||@A $x$", names: ["A"], segments: ["||", " $x$"] },
  { source: "@A|| $x$", names: ["A"], segments: ["||", " $x$"] },
])(
  "keeps strict profile/spoiler intersection boundaries: $source",
  ({ source, names, segments }) => {
    const references = { names, channels: [] };
    expect(hostSegments(source, references)).toEqual(segments);
    expect(
      indexMessage(source, { ...on, references }).drawn.map((span) => span.tex),
    ).toEqual(["x"]);
  },
);

it("preserves indented literal greater-than text while removing only parsed quote markers", () => {
  for (const source of [
    "$$\na\n    > b\n$$",
    "$$\na\n\t> b\n$$",
    "> $$\n> a\n>     > b\n> $$",
    "> $$\n> a\n    > b\n> $$",
    "> > $$\n> > a\n> >     > b\n> > $$",
    "- > $$\n    > a\n      > b\n    > $$",
    "   > $$\n   > a\n       > b\n   > $$",
    "> - $$\n>   a\n>       > b\n>   $$",
  ]) {
    const result = index(source),
      span = required(result.spans[0]);
    expect(span.tex, source).toBe("a\n> b");
    expect(span.source, source).toBe("$$\na\n> b\n$$");
    expect(result.drawn, source).toEqual([span]);
    expect(
      result.pieces("> b").map((piece) => piece.source),
      source,
    ).toEqual(["> b"]);
    const outcome = drawing.render(span.tex, true);
    expect(outcome.ok, source).toBe(true);
    if (!outcome.ok) throw Error(outcome.message);
    expect(
      [...outcome.element.querySelectorAll(".katex-mathml mo")].map(
        (node) => node.textContent,
      ),
      source,
    ).toContain(">");
  }
});
