// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import katex from "katex";
import { render, toMathML } from "./render";
import { fenceMode } from "./detect";
afterEach(() => vi.restoreAllMocks());
it("renders accessible HTML/MathML into a detached fresh root", () => {
  const result = render("x^2+1", false);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.element.matches("span.katex")).toBe(true);
  expect(result.element.isConnected).toBe(false);
  expect(
    result.element.querySelector(".katex-html")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(
    result.element.querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent,
  ).toBe("x^2+1");
});
it("keys display and flush-left layout separately", () => {
  const inline = render("layout", false),
    display = render("layout", true),
    fleqn = render("layout", true, { fleqn: true });
  expect(inline.ok && inline.element.className).toBe("katex");
  expect(display.ok && display.element.className).toBe("katex-display");
  expect(fleqn.ok && fleqn.element.classList.contains("fleqn")).toBe(true);
});
it("hands out clones so append/mutation cannot corrupt another caller", () => {
  const a = render("clone", false);
  if (!a.ok) throw Error(a.message);
  a.element.replaceChildren("changed");
  document.body.append(a.element);
  const b = render("clone", false);
  if (!b.ok) throw Error(b.message);
  expect(b.element).not.toBe(a.element);
  expect(b.element.textContent).not.toBe("changed");
  expect(b.element.isConnected).toBe(false);
  a.element.remove();
});
it("accepts accented Unicode math without strict-mode console warnings", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(render("é+strictAudit", false).ok).toBe(true);
  expect(warning).not.toHaveBeenCalled();
});
it("caps user-specified rule dimensions at 20 em", () => {
  const result = render(String.raw`\rule{500em}{600em}`, false);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  const rule = result.element.querySelector<HTMLElement>(".mord.rule");
  expect(rule?.style.borderRightWidth).toBe("20em");
  expect(rule?.style.borderTopWidth).toBe("20em");
});
// Safe boundary probes, not the million-em report payload. Check actual layout
// depth and both public outputs, not the dependency-patch mechanism.
it.each([
  [21, "em"],
  [50, "ex"],
  [210, "pt"],
  [400, "mu"],
  [8, "cm"],
] as const)(
  "bounds negative rule depth with the existing 20em size cap: -%s%s",
  (value, unit) => {
    const tex = String.raw`\rule[-${value}${unit}]{1em}{1em}`;
    const result = render(tex, false);
    if (!result.ok) throw Error(result.message);
    expect(
      result.element.querySelector<HTMLElement>(".mord.rule")?.style.bottom,
    ).toBe("-20em");
    const depths = [
      ...result.element.querySelectorAll<HTMLElement>(".strut"),
    ].map((node) => -(Number.parseFloat(node.style.verticalAlign) || 0));
    expect(Math.max(...depths)).toBe(20);
    expect(toMathML(tex, false)).toContain('depth="20em"');
    expect(toMathML(tex, false)).toContain('voffset="-20em"');
  },
);
it("preserves ordinary negative offsets below the existing size cap", () => {
  const tex = String.raw`\rule[-19em]{1em}{1em}`,
    result = render(tex, false);
  if (!result.ok) throw Error(result.message);
  expect(
    result.element.querySelector<HTMLElement>(".mord.rule")?.style.bottom,
  ).toBe("-19em");
  expect(toMathML(tex, false)).toContain('depth="19em"');
});
it.each([
  String.raw`\def\localmacro{x}\localmacro`,
  String.raw`\gdef\localmacro{x}\localmacro`,
  String.raw`\edef\localmacro{x}\localmacro`,
  String.raw`\xdef\localmacro{x}\localmacro`,
  String.raw`\let\localmacro=x\localmacro`,
  String.raw`\futurelet\localmacro xy`,
  String.raw`\newcommand{\localmacro}{x}\localmacro`,
  String.raw`\renewcommand{\alpha}{x}\alpha`,
  String.raw`\providecommand{\localmacro}{x}\localmacro`,
  String.raw`\global\def\localmacro{x}\localmacro`,
  String.raw`\global\long\def\localmacro{x}\localmacro`,
  String.raw`\expandafter\def\expandafter\localmacro\expandafter{x}\localmacro`,
])(
  "refuses sender macro assignments before replacement output expands: %s",
  (tex) => {
    expect(render(tex, false)).toMatchObject({
      ok: false,
      message: "Sender-defined macros are not supported",
    });
    expect(toMathML(tex, false)).toBeUndefined();
  },
);
it("keeps ordinary built-ins, literal definition text and macro isolation working", () => {
  expect(render(String.raw`\verb|\def| + \ce{H2O}`, false).ok).toBe(true);
  expect(render("x % \\def\\ignored{y}\n + z", false).ok).toBe(true);
  expect(render(String.raw`\localmacro`, false).ok).toBe(false);
  expect(toMathML(String.raw`\localmacro`, false)).toBeUndefined();
});
it("allows public equation tags but refuses authored private macro replay", () => {
  expect(render(String.raw`x\tag{public}`, true).ok).toBe(true);
  expect(toMathML(String.raw`x\tag{1}`, true)).toContain("<math");
  expect(render(String.raw`\tag{label}\df@tag`, true)).toMatchObject({
    ok: false,
    message: "Internal TeX commands are not supported",
  });
  expect(toMathML(String.raw`\tag{label}\df@tag`, true)).toBeUndefined();
  expect(render(String.raw`\text{a@b.com}`, false).ok).toBe(true);
});
it.each(
  ["nonumber", "notag"].flatMap((command) =>
    ["align", "equation"].flatMap((environment) =>
      ["HTML", "MathML"].map((output) => ({ command, environment, output })),
    ),
  ),
)(
  "preserves public $command in $environment in $output",
  ({ command, environment, output }) => {
    const body =
      environment === "align" ? `a&=b\\${command}\\\\c&=d` : `a=b\\${command}`;
    const tex = `\\begin{${environment}}${body}\\end{${environment}}`;
    if (output === "HTML") {
      const result = render(tex, true);
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error(result.message);
      // Suppress the selected row, not every row or merely the error message.
      expect(result.element.querySelectorAll(".eqn-num")).toHaveLength(
        environment === "align" ? 1 : 0,
      );
    } else {
      const vanilla = katex
        .renderToString(tex, {
          displayMode: true,
          output: "mathml",
          strict: "ignore",
        })
        .match(/<math[\s\S]*<\/math>/)?.[0];
      expect(toMathML(tex, true)).toBe(vanilla);
      expect(toMathML(tex, true)).toContain("<math");
    }
  },
);
it.each([String.raw`x\tag{public}`, String.raw`x\tag*{public}`])(
  "preserves the other public assignment expansion: %s",
  (tex) => {
    expect(render(tex, true).ok).toBe(true);
    expect(toMathML(tex, true)).toContain("public");
  },
);
it.each([
  String.raw`\gdef\@eqnsw{1}`,
  String.raw`\gdef\@eqnsw{0}`,
  String.raw`\@eqnsw`,
  String.raw`\df@tag`,
])("refuses authored private numbering/tag state: %s", (tex) => {
  expect(render(tex, true)).toMatchObject({
    ok: false,
    message: "Internal TeX commands are not supported",
  });
  expect(toMathML(tex, true)).toBeUndefined();
});
it("does not leak suppressed numbering into a subsequent render", () => {
  expect(
    render(String.raw`\begin{equation}a=b\nonumber\end{equation}`, true).ok,
  ).toBe(true);
  const result = render(String.raw`\begin{equation}a=b\end{equation}`, true);
  if (!result.ok) throw Error(result.message);
  expect(result.element.querySelectorAll(".eqn-num")).toHaveLength(1);
});
it("keeps unsupported label distinct from the sender-assignment policy", () => {
  expect(render(String.raw`x\label{eq:x}`, true)).toMatchObject({
    ok: false,
    message: expect.stringContaining("Undefined control sequence"),
  });
});
it("reports the ParseError raw message and position", () => {
  expect(render(String.raw`x+\notacommand`, false)).toMatchObject({
    ok: false,
    message: expect.stringContaining("Undefined control sequence"),
    position: expect.any(Number),
  });
});
it.each(
  ["alignat", "alignat*", "alignedat"].flatMap((environment) =>
    ["HTML", "MathML"].map((output) => ({ environment, output })),
  ),
)(
  "caps declared columns for $environment before $output allocation",
  ({ environment, output }) => {
    // 17 pairs is safe to run on the old version, but exceeds our 32 columns.
    const tex = `\\begin{${environment}}{17}a&=b\\end{${environment}}`;
    if (output === "HTML")
      expect(render(tex, true)).toMatchObject({
        ok: false,
        tooLarge: true,
        message: expect.stringContaining("maximum 32"),
      });
    else expect(toMathML(tex, true)).toBeUndefined();
  },
);
it.each([
  String.raw`\begin{alignedat}{999999999999999999999}a&=b\end{alignedat}`,
  String.raw`\begin{alignat*}{1000000000}a&=b\end{alignat*}`,
  String.raw`\begin{alignedat}{\char49}a&=b\end{alignedat}`,
  String.raw`\begin{\char97lignat}{1}a&=b\end{alignat}`,
  String.raw`\TextOrMath{x}{\url}{a%20}\begin{alignedat}{1000000000}a&=b\end{alignedat}`,
  String.raw`\verb*Xunterminated`,
])(
  "refuses unsafe preflight input without entering either KaTeX path: %s",
  (tex) => {
    // Deterministic public-boundary gate. Never send a dangerous count to the
    // real old renderer during fail-first runs: both allocation entry points
    // are intercepted, not timed or interrupted after the allocation begins.
    const html = vi.spyOn(katex, "render").mockImplementation(() => {
      throw Error("Must not enter KaTeX");
    });
    const mathml = vi.spyOn(katex, "renderToString").mockImplementation(() => {
      throw Error("Must not enter KaTeX");
    });
    expect(render(tex, true).ok).toBe(false);
    expect(toMathML(tex, true)).toBeUndefined();
    expect(html).not.toHaveBeenCalled();
    expect(mathml).not.toHaveBeenCalled();
  },
);
it("accepts bounded alignments and native array/matrix inputs", () => {
  for (const tex of [
    String.raw`\begin{alignedat}{00016}a&=b\end{alignedat}`,
    String.raw`\begin{alignat}1a&=b\end{alignat}`,
    "\\begin% name\n{alignedat}% pairs\n{1% join\n6}a&=b\\end{alignedat}",
    `\\begin{array}{${"c".repeat(33)}}x\\end{array}`,
    `\\begin{darray}{${"c".repeat(33)}}x\\end{darray}`,
    String.raw`\begin{array}{\char99}x\end{array}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\substack{a\\b}`,
    String.raw`\verb|\begin{alignedat}{17}|`,
    String.raw`\\begin{alignedat}{17}`,
    "x % \\begin{alignedat}{17}\n+y",
  ]) {
    expect(render(tex, true).ok, tex).toBe(true);
    expect(toMathML(tex, true), tex).toContain("<math");
  }
});
it.each(
  [
    "x % \\df@tag\n+y",
    "x % \\df@tag\r+y",
    String.raw`\verb|\df@tag| + x`,
    String.raw`\verb*X\df@tagX +x`,
    String.raw`\verb \df@tag `,
    "\\verb\n\\df@tag\n +x",
    String.raw`\verb@\df@tag@ + x`,
    String.raw`x\\@eqnsw`,
    `${String.raw`\% % \df@tag`}\nx`,
  ].flatMap((tex) => ["HTML", "MathML"].map((output) => ({ tex, output }))),
)(
  "does not mistake lexer-inert text for a private control token in $output: $tex",
  ({ tex, output }) => {
    if (output === "HTML") expect(render(tex, true).ok).toBe(true);
    else {
      const vanilla = katex
        .renderToString(tex, {
          displayMode: true,
          output: "mathml",
          strict: "ignore",
          trust: false,
        })
        .match(/<math[\s\S]*<\/math>/)?.[0];
      expect(toMathML(tex, true)).toBe(vanilla);
      expect(toMathML(tex, true)).toContain("<math");
    }
  },
);
it.each([
  String.raw`\verb|\@eqnsw|\@eqnsw`,
  String.raw`x\\\@eqnsw`,
  String.raw`\%\@eqnsw`,
])(
  "still refuses real private tokens after escapes and verbatim: %s",
  (tex) => {
    expect(render(tex, true)).toMatchObject({
      ok: false,
      message: "Internal TeX commands are not supported",
    });
    expect(toMathML(tex, true)).toBeUndefined();
  },
);
it("caps input, bounds macro expansion, and renders mhchem", () => {
  expect(render("x".repeat(10_001), false)).toEqual({
    ok: false,
    message: "Too long to typeset",
    tooLarge: true,
  });
  expect(render(String.raw`\def\loop{\loop}\loop`, false)).toMatchObject({
    ok: false,
  });
  expect(render(String.raw`\ce{2 H2 + O2 -> 2 H2O}`, true).ok).toBe(true);
});
it("does not create active links or images from untrusted TeX", () => {
  Object.defineProperty(Object.prototype, "trust", {
    value: true,
    writable: true,
    configurable: true,
  });
  try {
    expect(render("prototype-pollution-sentinel", false).ok).toBe(true);
    for (const tex of [
      String.raw`\href{javascript:alert(1)}{evil}`,
      String.raw`\url{https://example.test}`,
      String.raw`\includegraphics{https://example.test/a.png}`,
    ]) {
      const outcome = render(tex, false);
      expect(outcome).toMatchObject({
        ok: false,
        message: "Links, images and HTML commands are not supported",
      });
      expect(toMathML(tex, false)).toBeUndefined();
    }
  } finally {
    delete (Object.prototype as { trust?: boolean }).trust;
  }
});
it("keeps at most 512 cached outcomes with LRU refresh", () => {
  const spy = vi.spyOn(katex, "render");
  render("oldestCacheEntry", false);
  render("refreshedCacheEntry", false);
  for (let i = 0; i < 510; i++) render(`c_{${i}}`, false);
  render("refreshedCacheEntry", false);
  render("overflowCacheEntry", false);
  spy.mockClear();
  render("refreshedCacheEntry", false);
  expect(spy).not.toHaveBeenCalled();
  render("oldestCacheEntry", false);
  expect(spy).toHaveBeenCalledTimes(1);
});
it("turns unexpected engine failures into a stable safe error", () => {
  vi.spyOn(katex, "render").mockImplementationOnce(() => {
    throw Error("private internals");
  });
  expect(render("unexpected-error-test", false)).toEqual({
    ok: false,
    message: "Couldn't typeset this",
  });
});
it("returns only MathML, keeps annotation, and refuses invalid/large input", () => {
  expect(toMathML(String.raw`\frac{a}{b}`, true)).toMatch(
    /^<math[\s\S]*<\/math>$/,
  );
  expect(toMathML(String.raw`\frac{a}{b}`, true)).toContain(
    'encoding="application/x-tex"',
  );
  expect(toMathML("\\notacommand", false)).toBeUndefined();
  expect(toMathML("x".repeat(10_001), false)).toBeUndefined();
});
it.each<[string, string | null]>([
  [" math ", "math"],
  ["KaTeX", "math"],
  [" LATEX ", "latex"],
  ["TeX", "latex"],
  ["python", null],
])("classifies fence %s", (language, mode) =>
  expect(fenceMode(language)).toBe(mode),
);

it.each([
  String.raw`a+\href{/docs}{b}+c`,
  String.raw`\url{https://example.test}`,
  String.raw`\includegraphics{/image.png}`,
  String.raw`\htmlClass{example}{b}`,
  String.raw`\htmlId{example}{b}`,
  String.raw`\htmlStyle{color:red}{b}`,
  String.raw`\htmlData{example=value}{b}`,
  String.raw`a+\href{https&colon;//example.test}{b}+c`,
  String.raw`\url{1invalid:example}`,
  `${String.raw`\url{a%20} + x % \df@tag`}\n+y`,
  String.raw`\url{a%20}\@eqnsw`,
  String.raw`\includegraphics[width=1em]{a%20}\@eqnsw`,
])(
  "fails rather than silently dropping a trust-denied command's arguments: %s",
  (tex) => {
    expect(render(tex, false)).toMatchObject({
      ok: false,
      message: "Links, images and HTML commands are not supported",
    });
    expect(render(tex, true, { fleqn: true })).toMatchObject({
      ok: false,
      message: "Links, images and HTML commands are not supported",
    });
    expect(toMathML(tex, false)).toBeUndefined();
    expect(toMathML(tex, true)).toBeUndefined();
  },
);
it("refuses trust commands before both KaTeX paths without poisoning ordinary rendering", () => {
  const html = vi.spyOn(katex, "render"),
    mathml = vi.spyOn(katex, "renderToString"),
    tex = String.raw`a+\href{/cached-pass15}{b}+c`;
  const first = render(tex, false);
  expect(first).toMatchObject({
    ok: false,
    message: "Links, images and HTML commands are not supported",
  });
  expect(render(tex, false)).toBe(first);
  expect(toMathML(tex, false)).toBeUndefined();
  expect(html).not.toHaveBeenCalled();
  expect(mathml).not.toHaveBeenCalled();
  expect(render("afterTrustDenial", false).ok).toBe(true);
  expect(html).toHaveBeenLastCalledWith(
    "afterTrustDenial",
    expect.any(HTMLElement),
    expect.objectContaining({ trust: false }),
  );
  expect(toMathML("afterTrustDenial", false)).toContain("<math");
  expect(mathml).toHaveBeenLastCalledWith(
    "afterTrustDenial",
    expect.objectContaining({ trust: false }),
  );
});
it.each([
  String.raw`\verb|\href{/docs}{b}|`,
  String.raw`\text{\textbackslash href}`,
  "x % \\href{/docs}{b}\n+y",
])("does not refuse inert spellings of trusted commands: %s", (tex) => {
  expect(render(tex, false).ok).toBe(true);
  expect(toMathML(tex, false)).toContain("<math");
});
