// @vitest-environment jsdom
import { expect, it } from "vitest";
import { tool } from "./tool";
import { render } from "./render";
const call = (args: Record<string, unknown>) => tool.call(null, null, args);
it("describes when to check, supported delimiters/chemistry, and forbidden links", () => {
  expect(tool.name).toBe("math_check");
  for (const word of [
    "before sending",
    "$…$",
    "$$…$$",
    "math fence",
    "\\ce{}",
    "\\href",
    "\\url",
  ])
    expect(tool.description).toContain(word);
});
it("requires exactly one string input and validates display", async () => {
  for (const args of [
    {},
    { markdown: "$x$", tex: "x" },
    { markdown: 7 },
    { tex: false },
    { tex: "x", display: "yes" },
  ])
    await expect(call(args)).rejects.toThrow();
});
it("validates addressed drafts without requiring a host reference directory", async () => {
  expect(await call({ markdown: "@Ana see $E=mc^2$" })).toContain(
    "Summary: 1 spans, 1 render, 0 fail",
  );
});
it("reports raw TeX, line/delimiter, success and ParseError, then a summary", async () => {
  const report = await call({ markdown: "Intro\n\n$x^2$\n\n$$\\fracc{a}$$" });
  expect(report).toContain("✓ line 3 $…$ x^2");
  expect(report).toContain(
    '✗ line 5 $$…$$ "\\fracc{a}" → Undefined control sequence',
  );
  expect(report).toContain("Summary: 2 spans, 1 render, 1 fail");
});
it("checks standalone TeX, including chemistry and the input cap", async () => {
  expect(await call({ tex: String.raw`\ce{H2O}`, display: true })).toContain(
    "Summary: 1 spans, 1 render, 0 fail",
  );
  expect(await call({ tex: "x".repeat(10_001) })).toContain(
    "Too long to typeset",
  );
});
it("checks math fences but never scans inline/non-math code as prose", async () => {
  const report = await call({
    markdown: "```math\n\\frac{a}{b}\n```\n\n`$skip$`\n\n```js\n$x$\n```",
  });
  expect(report).toContain("✓ line 1 math fence \\frac{a}{b}");
  expect(report).toContain("Summary: 1 spans, 1 render, 0 fail");
});
it.each(["math", "katex", "latex", "tex"])(
  "preserves a fence's terminal control-space token: %s",
  async (language) => {
    const tex = " x\\ ";
    expect(render(tex, true).ok).toBe(true);
    expect(
      await call({ markdown: `\`\`\`${language}\n${tex}\n\`\`\`` }),
    ).toContain("Summary: 1 spans, 1 render, 0 fail");
  },
);
it("applies the render length cap to the untrimmed fence body", async () => {
  const tex = `x${" ".repeat(10_000)}`;
  expect(render(tex, true)).toMatchObject({ ok: false, tooLarge: true });
  const report = await call({ markdown: `~~~math\n${tex}\n~~~` });
  expect(report).toContain("Too long to typeset");
  expect(report).toContain("Summary: 1 spans, 0 render, 1 fail");
});
it.each([
  ["    ```math\n    \\fracc{a}\n    ```", 5],
  ["    > ```math\n    > \\fracc{a}\n    > ```", 5],
  ["    - item\n\n      ```math\n      \\fracc{a}\n      ```", 7],
])(
  "checks a math fence nested inside a GFM footnote: %s",
  async (fence, line) => {
    const report = await call({
      markdown: `See[^n].\n\n[^n]: note\n\n${fence}`,
    });
    expect(report).toContain(`✗ line ${line} math fence`);
    expect(report).toContain("Undefined control sequence: \\fracc");
    expect(report).toContain("Summary: 1 spans, 0 render, 1 fail");
  },
);
it("does not scan footnote prose or non-math code while collecting nested fences", async () => {
  const markdown =
    "See[^n].\n\n[^n]: $ x$ and $\\fracc{a}$\n\n    ```js\n    $ x$ and \\fracc{a}\n    ```\n\n    ```math\n    x+y\n    ```";
  const report = await call({ markdown });
  expect(report).toContain("Summary: 1 spans, 1 render, 0 fail");
  expect(report).not.toContain("Warning");
});
it("warns for delimiter mistakes without treating prices as expressions", async () => {
  const report = await call({
    markdown: "$ x$\n\n$$\n\n\\\\(x\\\\)\n\n$5 and $10",
  });
  expect(report).toContain("$ followed by a space");
  expect(report).toContain("unclosed $$");
  expect(report).toContain("doubled backslash");
  expect(report).toContain("Summary: 0 spans, 0 render, 0 fail");
});
it("warns without repairing silently accepted doubled commands", async () => {
  const tex = String.raw`\\frac{1}{2}`;
  for (const args of [
    { tex },
    { markdown: `$${tex}$` },
    { markdown: `~~~ math\n${tex}\n~~~` },
  ]) {
    const result = await call(args);
    expect(result).toContain("doubled backslash before \\frac");
    expect(result).toContain(tex);
    expect(result).toContain("Summary: 1 spans, 1 render, 0 fail");
  }
  expect(await call({ tex: String.raw`\\alpha` })).toContain(
    "doubled backslash before \\alpha",
  );
});
it.each([
  String.raw`a \\ b`,
  String.raw`\\[2pt]`,
  String.raw`\\\hline`,
  String.raw`\\\\frac`,
  String.raw`\\notARealCommand`,
  String.raw`\verb|\\frac|`,
  String.raw`\verb*|% \\frac|`,
  "% \\\\frac\nx",
  `${String.raw`\% % \\frac`}\nx`,
])(
  "does not invent doubled-command hints in rowbreaks/literals: %s",
  async (tex) => {
    expect(await call({ tex })).not.toContain("doubled backslash");
  },
);
it("resumes after comments/verbatim and warns only for the later command", async () => {
  const result = await call({
    tex: `${String.raw`\verb|\\frac| % \\sum`}\n${String.raw`\\sqrt{x}`}`,
  });
  const warnings = result
    .split("\n")
    .filter((line) => line.startsWith("Warning"));
  expect(warnings).toEqual([expect.stringContaining("before \\sqrt")]);
});
it("does not lint commands inside Markdown's literal code", async () => {
  expect(
    await call({ markdown: "`\\\\frac{1}{2}`\n\n```text\n\\\\sum\n```" }),
  ).not.toContain("doubled backslash");
});
it("warns about display environments inside inline dollars and dollars inside math", async () => {
  const report = await call({
    markdown: `${String.raw`$\begin{align}a&=b\end{align}$`}\n\n${String.raw`$$x$y$$`}`,
  });
  expect(report).toContain("display-only environment");
  expect(report).toContain("unescaped $ inside math");
});
it.each([
  ["\\[x", "\\["],
  ["\\(x", "\\("],
  ["\\begin{align}\nx", "environment"],
])(
  "uses the detector end state for an unclosed %s",
  async (markdown, label) => {
    expect(await call({ markdown })).toContain(`unclosed ${label}`);
  },
);
it("checks a bare environment with commented headers without an unclosed warning", async () => {
  const source = "\\begin{align}\n% \\begin{align}\na &= b\n\\end{align}";
  const report = await call({ markdown: source });
  expect(report).toContain("Summary: 1 spans, 1 render, 0 fail");
  expect(report).not.toContain("unclosed");
});
it("warns when a bare environment's only closer is commented out", async () => {
  const report = await call({
    markdown: "\\begin{align}\na &= b\n% \\end{align}",
  });
  expect(report).toContain("unclosed environment");
  expect(report).toContain("Summary: 0 spans, 0 render, 0 fail");
});
it("does not invent near-miss warnings from valid closers or literal code", async () => {
  const report = await call({
    markdown: "$x$ then text\n\n```txt\n$ x$\n$$\n\\\\(\n```",
  });
  expect(report).not.toContain("Warning");
});
it("keeps the report within 4 KiB while preserving accurate counts", async () => {
  const report = await call({
    markdown: Array.from({ length: 500 }, (_, i) => `$x_{${i}}$`).join(" "),
  });
  expect(new TextEncoder().encode(report).length).toBeLessThanOrEqual(4096);
  expect(report).toContain("additional details omitted");
  expect(report).toContain("Summary: 500 spans, 500 render, 0 fail");
});
it("has no visible document writes and surfaces the message cap", async () => {
  const before = document.body.innerHTML;
  await call({ markdown: "$x$" });
  expect(document.body.innerHTML).toBe(before);
  expect(await call({ markdown: "x".repeat(100_001) })).toContain(
    "100,000-character detection cap",
  );
});
it("refuses macro definitions in standalone, prose and fences and never recommends their repair", async () => {
  const tex = String.raw`\newcommand{\toolmacro}{x}\toolmacro`;
  for (const args of [
    { tex },
    { markdown: `$${tex}$` },
    { markdown: `~~~math\n${tex}\n~~~` },
  ]) {
    const report = await call(args);
    expect(report).toContain("Sender-defined macros are not supported");
    expect(report).toContain("Summary: 1 spans, 0 render, 1 fail");
  }
  for (const sample of [
    String.raw`\def\q{x}\q`,
    String.raw`\gdef\q{x}\q`,
    String.raw`\edef\q{x}\q`,
    String.raw`\xdef\q{x}\q`,
    String.raw`\let\q=x\q`,
    String.raw`\futurelet\q xy`,
    String.raw`\newcommand{\q}{x}\q`,
    String.raw`\renewcommand{\alpha}{x}\alpha`,
    String.raw`\providecommand{\q}{x}\q`,
  ])
    expect(await call({ tex: sample })).toContain(
      "Summary: 1 spans, 0 render, 1 fail",
    );
  for (const name of [
    "def",
    "gdef",
    "edef",
    "xdef",
    "let",
    "futurelet",
    "newcommand",
    "renewcommand",
    "providecommand",
  ])
    expect(await call({ tex: `\\\\${name}` })).not.toContain(
      "use a single backslash",
    );
});
it.each(["nonumber", "notag"])(
  "checks built-in numbering suppression in standalone, prose and fences: %s",
  async (command) => {
    const tex =
      String.raw`\begin{align}a&=b` +
      `\\${command}` +
      String.raw`\\c&=d\end{align}`;
    for (const args of [
      { tex, display: true },
      { markdown: `$$${tex}$$` },
      { markdown: `~~~math\n${tex}\n~~~` },
    ])
      expect(await call(args)).toContain("Summary: 1 spans, 1 render, 0 fail");
  },
);
it("reports the preflight column cap in standalone, prose and fences", async () => {
  const tex = String.raw`\begin{alignat}{17}a&=b\end{alignat}`;
  for (const args of [
    { tex, display: true },
    { markdown: `$$${tex}$$` },
    { markdown: `~~~math\n${tex}\n~~~` },
  ]) {
    const report = await call(args);
    expect(report).toContain("maximum 32");
    expect(report).toContain("Summary: 1 spans, 0 render, 1 fail");
  }
});
it("checks inert private spellings in standalone, prose and fences", async () => {
  const tex = String.raw`\verb|\df@tag| + x`;
  for (const args of [
    { tex, display: true },
    { markdown: `$$${tex}$$` },
    { markdown: `~~~math\n${tex}\n~~~` },
  ])
    expect(await call(args)).toContain("Summary: 1 spans, 1 render, 0 fail");
});
it("still checks a math fence when a bare Buzz candidate disables prose math", async () => {
  expect(
    await call({ markdown: "buzz://channel/general\n\n~~~math\nx+y\n~~~" }),
  ).toContain("Summary: 1 spans, 1 render, 0 fail");
});

it.each(["verb", "verb*"])(
  "checks bare environments with a complete %s token without unclosed warnings",
  async (command) => {
    const source = `\\begin{align}\na&=\\${command}|\\begin{align}|\n\\end{align}`,
      report = await call({ markdown: source });
    expect(report).toContain("Summary: 1 spans, 1 render, 0 fail");
    expect(report).not.toContain("unclosed");
  },
);
it("checks a CR-terminated bare environment before prose", async () => {
  expect(
    await call({ markdown: "\\begin{equation}x=y\\end{equation}\rAfter" }),
  ).toContain("Summary: 1 spans, 1 render, 0 fail");
});

it.each([
  { tex: String.raw`a+\href{/docs}{b}+c` },
  { markdown: String.raw`$a+\href{/docs}{b}+c$` },
  { markdown: String.raw`$$a+\href{/docs}{b}+c$$` },
  { markdown: "```math\n\\href{https://example.com}{x=1}\n```" },
  { tex: String.raw`a+\href{https&colon;//example.test}{b}+c` },
])(
  "reports trust-denied argument loss as a failed render: %j",
  async (args) => {
    const report = await call(args);
    expect(report).toContain(
      "Links, images and HTML commands are not supported",
    );
    expect(report).toContain("Summary: 1 spans, 0 render, 1 fail");
  },
);
