import { expect, it } from "vitest";
import type { Element, Nodes, Root } from "hast";
import { MAX_RENDER_CHARS } from "../office-types";
import { MAX_OFFICE_BYTES } from "../formats";
import { openTextDocument } from "./text-document";
import { required } from "./required";
import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "../formats";

const origin = "https://relay.test";
const picture = `${origin}/media/${"b".repeat(64)}.png`;
async function open(
  source: string | Uint8Array,
  name: string,
  signal = new AbortController().signal,
) {
  const bytes =
    typeof source === "string" ? new TextEncoder().encode(source) : source;
  const result = await openTextDocument(bytes, name, signal, {
    isCommunityMedia: (value) => value === picture,
  });
  expect(result).toMatchObject({
    ok: true,
    office: {
      doc: { family: "document", parsed: { kind: "markdown" }, charts: [] },
    },
  });
  if (
    !result.ok ||
    !("office" in result) ||
    result.office.doc.family !== "document"
  )
    throw new Error("Expected rich text document");
  return result.office.doc;
}
function nodes(tree: Root | Element, tag?: string): Element[] {
  const pending: Nodes[] = [tree],
    found: Element[] = [];
  while (pending.length) {
    const node = required(pending.pop());
    if (node.type === "element" && (!tag || node.tagName === tag))
      found.push(node);
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        pending.push(required(node.children[at]));
  }
  return found;
}
function text(tree: Root | Element): string {
  const pending: Nodes[] = [tree],
    values: string[] = [];
  while (pending.length) {
    const node = required(pending.pop());
    if (node.type === "text") values.push(node.value);
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        pending.push(required(node.children[at]));
  }
  return values.join("");
}

it("opens reStructuredText headings, prose, footnotes, lists, code, tables, notes, math and media", async () => {
  const doc = await open(
    `=========\nRST title\n=========\n\nSection\n-------\n\n*emphasis* **strong** \`\`literal\`\` and \`site <https://example.test/read>\`_ [1]_.\n\n.. [1] Footnote **body**.\n\n* first\n* second\n\n1. one\n2. two\n\nTerm\n  Definition\n\n:Field: Value\n\n.. code-block:: python\n\n   print("<tag>")\n\nLiteral::\n\n   saved <html>\n\n+------+-----+\n| Head | Two |\n+======+=====+\n| A    | B   |\n+------+-----+\n\n===== =====\nOne   Two\n===== =====\nC     D\n===== =====\n\n  Quoted paragraph.\n\n.. note:: Remember\n\n   **Nested** note.\n\n.. danger:: Stop\n\n.. math::\n\n   x^2 + y^2\n\nInline :math:\`x+y\`.\n\n.. image:: ${picture}\n   :alt: Saved picture\n\n.. figure:: ${picture}\n\n   Figure caption.\n\n.. ordinary comment hidden\n\n.. |unknown| replace:: substitution stays visible\n\n.. include:: https://external.test/never-read\n\n.. raw:: html\n\n   <script>literal unknown raw directive</script>\n`,
    "guide.rst",
  );
  const tree = doc.parsed.tree;
  expect(doc.parsed.outline.map((h) => [h.depth, h.text])).toEqual([
    [1, "RST title"],
    [2, "Section"],
  ]);
  expect(nodes(tree, "em").map(text)).toContain("emphasis");
  expect(nodes(tree, "strong").map(text)).toContain("strong");
  expect(
    nodes(tree, "a").some(
      (node) => node.properties.href === "https://example.test/read",
    ),
  ).toBe(true);
  expect(
    nodes(tree, "a").some((node) =>
      String(node.properties.href).startsWith("#"),
    ),
  ).toBe(true);
  expect(text(tree)).toContain("Footnote body.");
  expect(nodes(tree, "ul")).toHaveLength(1);
  expect(nodes(tree, "ol").length).toBeGreaterThanOrEqual(2);
  expect(nodes(tree, "dl")).toHaveLength(2);
  expect(
    nodes(tree, "code").some(
      (node) =>
        node.properties.dataLanguage === "python" &&
        text(node).includes('print("<tag>")'),
    ),
  ).toBe(true);
  expect(nodes(tree, "table")).toHaveLength(2);
  expect(
    nodes(tree, "table").map((table) =>
      nodes(table, "tr").map((row) =>
        nodes(row)
          .filter((cell) => cell.tagName === "th" || cell.tagName === "td")
          .map(text),
      ),
    ),
  ).toEqual([
    [
      ["Head", "Two"],
      ["A", "B"],
    ],
    [
      ["One", "Two"],
      ["C", "D"],
    ],
  ]);
  expect(nodes(tree, "blockquote")).toHaveLength(1);
  expect(nodes(tree, "div").map((node) => node.properties.dataAlert)).toEqual([
    "note",
    "caution",
  ]);
  expect(
    nodes(tree, "code").some(
      (node) =>
        node.properties.dataLanguage === "math" &&
        text(node).includes("x^2 + y^2"),
    ),
  ).toBe(true);
  expect(
    nodes(tree, "code").find((node) => node.properties.dataMath === "inline"),
  ).toMatchObject({ children: [{ type: "text", value: "x+y" }] });
  expect(nodes(tree, "img").map((node) => node.properties.src)).toEqual([
    picture,
    picture,
  ]);
  expect(text(tree)).not.toContain("ordinary comment hidden");
  expect(text(tree)).toContain(".. |unknown| replace::");
  expect(text(tree)).toContain(".. include:: https://external.test/never-read");
  expect(text(tree)).toContain(
    "<script>literal unknown raw directive</script>",
  );
  expect(nodes(tree, "script")).toHaveLength(0);
});

it("opens AsciiDoc headings, substitutions, prose, footnotes, lists, listings, tables, notes, math and images", async () => {
  const doc = await open(
    `= AsciiDoc title\n:who: reader\n\nSection\n-------\n\nHello {who}, *bold* _em_ \`mono\` link:https://example.test/read[Link] https://example.test/plain[URL] footnote:n[Saved note].\n\n* bullet\n* next\n\n. one\n. two\n\nTerm:: Definition\nOther:: Another\n\n[source,javascript]\n----\nconst saved = "<script>";\n----\n\n|===\n|One |Two\n|A |B\n|===\n\n____\nQuoted paragraph.\n____\n\nNOTE: Saved note.\n\n[WARNING]\n====\nBlock warning.\n====\n\n[stem]\n++++\nx^2\n++++\n\nInline stem:[x+y] and latexmath:[z].\n\nimage::${picture}[Saved image]\n\n// comment hidden\n////\nblock comment hidden\n////\n\ninclude::https://external.test/never-read[]\n\n<iframe>literal author HTML</iframe>\n`,
    "guide.adoc",
  );
  const tree = doc.parsed.tree;
  expect(doc.parsed.outline.map((h) => [h.depth, h.text])).toEqual([
    [1, "AsciiDoc title"],
    [2, "Section"],
  ]);
  expect(text(tree)).toContain("Hello reader");
  expect(nodes(tree, "strong").map(text)).toContain("bold");
  expect(nodes(tree, "em").map(text)).toContain("em");
  expect(
    nodes(tree, "a").some(
      (node) => node.properties.href === "https://example.test/read",
    ),
  ).toBe(true);
  expect(nodes(tree, "ul")).toHaveLength(1);
  expect(nodes(tree, "dl")).toHaveLength(1);
  expect(
    nodes(tree, "code").some(
      (node) =>
        node.properties.dataLanguage === "javascript" &&
        nodes(node, "span").length > 0,
    ),
  ).toBe(true);
  expect(nodes(tree, "table")).toHaveLength(1);
  expect(nodes(tree, "blockquote")).toHaveLength(1);
  expect(nodes(tree, "div").map((node) => node.properties.dataAlert)).toEqual([
    "note",
    "warning",
  ]);
  expect(
    nodes(tree, "code").some(
      (node) =>
        node.properties.dataLanguage === "math" && text(node).includes("x^2"),
    ),
  ).toBe(true);
  expect(
    nodes(tree, "code")
      .filter((node) => node.properties.dataMath === "inline")
      .map(text),
  ).toEqual(["x+y", "z"]);
  expect(nodes(tree, "img").map((node) => node.properties.src)).toEqual([
    picture,
  ]);
  expect(text(tree)).not.toContain("comment hidden");
  expect(text(tree)).toContain("include::https://external.test/never-read[]");
  expect(text(tree)).toContain("<iframe>literal author HTML</iframe>");
  expect(nodes(tree, "iframe")).toHaveLength(0);
});

it("opens LaTeX title metadata and structural commands without running unknown macros or includes", async () => {
  const source = String.raw`\documentclass{article}
\usepackage{never-loaded}
\title{Saved title}\author{Saved author}\date{Saved date}
\begin{document}
\maketitle
\section{Section}
\subsection{Subsection}
\emph{em} \textit{italic} \textbf{bold} \texttt{mono} \underline{under}, \href{https://example.test/read}{Link} \url{https://example.test/plain}.\footnote{Saved note}

Saved~space -- en --- em, ${"``"}quoted''.

\begin{itemize}\item first\item second\end{itemize}
\begin{enumerate}\item one\item two\end{enumerate}
\begin{description}\item[Term] Definition\end{description}
\begin{verbatim}
<script>saved code</script>
\end{verbatim}
\begin{lstlisting}[language=Python]
print("saved")
\end{lstlisting}
\begin{minted}{javascript}
const saved = 1;
\end{minted}
\begin{tabular}{ll}Head & Two \\ A & B \\\end{tabular}
\begin{quote}A quotation.\end{quote}
\begin{quotation}Another quotation.\end{quotation}
Inline $x+y$ and \(z\).

$$a^2$$
\[b^2\]
\begin{align*}c &= d\end{align*}
\includegraphics[width=2cm]{unavailable.png}
\label{ignored}
% comment hidden
\unknown{visible argument} \input{never-read.tex} <script>literal author HTML</script>
\end{document}`;
  const doc = await open(source, "guide.tex"),
    tree = doc.parsed.tree;
  expect(text(tree)).toContain("Saved title");
  expect(text(tree)).toContain("Saved author");
  expect(text(tree)).toContain("Saved date");
  expect(text(tree)).not.toContain("documentclass");
  expect(text(tree)).not.toContain("usepackage");
  expect(text(tree)).not.toContain("maketitle");
  expect(doc.parsed.outline.map((h) => h.text)).toContain("Section");
  expect(doc.parsed.outline.map((h) => h.text)).toContain("Subsection");
  expect(nodes(tree, "strong").map(text)).toContain("bold");
  expect(nodes(tree, "u").map(text)).toContain("under");
  expect(
    nodes(tree, "a").some(
      (node) => node.properties.href === "https://example.test/read",
    ),
  ).toBe(true);
  expect(text(tree)).toContain("Saved note");
  expect(text(tree)).toContain("Saved\u00a0space – en — em, “quoted”.");
  expect(nodes(tree, "ul")).toHaveLength(1);
  expect(nodes(tree, "dl")).toHaveLength(1);
  expect(nodes(tree, "table")).toHaveLength(1);
  expect(nodes(tree, "blockquote")).toHaveLength(2);
  expect(
    nodes(tree, "code").some(
      (node) => node.properties.dataLanguage === "python",
    ),
  ).toBe(true);
  expect(
    nodes(tree, "code").some(
      (node) => node.properties.dataLanguage === "javascript",
    ),
  ).toBe(true);
  expect(
    nodes(tree, "code")
      .filter((node) => node.properties.dataLanguage === "math")
      .map(text),
  ).toEqual(["a^2", "b^2", "c &= d"]);
  expect(
    nodes(tree, "code")
      .filter((node) => node.properties.dataMath === "inline")
      .map(text),
  ).toEqual(["x+y", "z"]);
  expect(required(nodes(tree, "img")[0]).properties).toMatchObject({
    alt: "unavailable.png",
  });
  expect(required(nodes(tree, "img")[0]).properties.src).toBeUndefined();
  expect(text(tree)).not.toContain("comment hidden");
  expect(text(tree)).not.toContain("ignored");
  expect(text(tree)).toContain("\\unknown{visible argument}");
  expect(text(tree)).toContain("\\input{never-read.tex}");
  expect(text(tree)).toContain("<script>literal author HTML</script>");
  expect(nodes(tree, "script")).toHaveLength(0);
});

it.each(["rst", "asciidoc", "latex"])(
  "keeps whole blocks on %s render truncation",
  async (extension) => {
    const source =
      "Kept paragraph.\n\n" +
      "x".repeat(MAX_RENDER_CHARS + 1) +
      "\n\nNot admitted.";
    const doc = await open(source, `large.${extension}`);
    expect(doc.truncated).toBe(true);
    expect(text(doc.parsed.tree)).toBe("Kept paragraph.");
  },
);

it("preserves a LaTeX fragment's source commands when there is no document environment", async () => {
  const doc = await open(
    String.raw`\documentclass{article} Visible fragment. \unknown{saved}`,
    "fragment.ltx",
  );
  expect(text(doc.parsed.tree)).toContain("\\documentclass{article}");
  expect(text(doc.parsed.tree)).toContain("Visible fragment.");
});

it.each(["rst", "adoc", "tex"])(
  "rejects invalid UTF-8 as not-text for %s",
  async (extension) => {
    expect(
      await openTextDocument(
        new Uint8Array([0xc3, 0x28]),
        `bad.${extension}`,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "not-text" } });
  },
);

it("uses the Office byte cap and skips a huge comment without truncating visible blocks", async () => {
  const source = `.. ${"x".repeat(MAX_FETCH_BYTES + 1)}\r\n\r\nVisible.\r\n`;
  const doc = await open(source, "long-comment.rst");
  expect(doc.truncated).toBeUndefined();
  expect(text(doc.parsed.tree)).toBe("Visible.");
  expect(
    await openTextDocument(
      new Uint8Array(MAX_OFFICE_BYTES + 1),
      "too-large.tex",
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "too-large" } });
});

it("yields large text loads to caller cancellation", async () => {
  const bytes = new TextEncoder().encode(
    `// ${"x".repeat(MAX_FETCH_BYTES + 1)}\nVisible.`,
  );
  const controller = new AbortController();
  const pending = openTextDocument(bytes, "cancel.adoc", controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  setTimeout(() => controller.abort(), 0);
  await assertion;
});

it("keeps intentional leading and interior blank lines in an AsciiDoc listing", async () => {
  const doc = await open(
    "[source,python]\n----\n\nfirst\n\nsecond\n----\n\nAfter.",
    "listing.adoc",
  );
  expect(nodes(doc.parsed.tree, "code").map(text)).toEqual([
    "\nfirst\n\nsecond",
  ]);
  expect(nodes(doc.parsed.tree, "p").map(text)).toEqual(["After."]);
});

it.each(["rst", "adoc", "tex"])(
  "keeps nested %s lists in their parent list item",
  async (dialect) => {
    const source =
      dialect === "rst"
        ? "* outer\n\n  * inner\n\n* next"
        : dialect === "adoc"
          ? "* outer\n\n** inner\n\n* next"
          : String.raw`\begin{itemize}\item outer\begin{itemize}\item inner\end{itemize}\item next\end{itemize}`;
    const doc = await open(source, `nested.${dialect}`),
      lists = nodes(doc.parsed.tree, "ul");
    expect(lists).toHaveLength(2);
    const parent = required(
      required(lists[0]).children.find(
        (node): node is Element =>
          node.type === "element" && node.tagName === "li",
      ),
    );
    expect(nodes(parent, "ul")).toHaveLength(1);
    expect(text(required(nodes(parent, "ul")[0]))).toBe("inner");
  },
);

it("keeps an unknown TeX macro and its nested argument syntax visible", async () => {
  const saved = String.raw`Before \unknown{\textbf{literal argument}} after.`,
    doc = await open(saved, "unknown.tex");
  expect(text(doc.parsed.tree)).toBe(saved);
  expect(nodes(doc.parsed.tree, "strong")).toHaveLength(0);
});

it.each([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
])(
  "reads the saved %s math environment as display math",
  async (environment) => {
    const doc = await open(
      `\\begin{${environment}}x &= y\\end{${environment}}`,
      "display.tex",
    );
    expect(
      nodes(doc.parsed.tree, "code").map((node) => [
        node.properties.dataLanguage,
        text(node),
      ]),
    ).toEqual([["math", "x &= y"]]);
    expect(
      nodes(doc.parsed.tree, "pre").map((node) => node.properties.dataMath),
    ).toEqual(["display"]);
  },
);

it.each(["code", "sourcecode"])(
  "highlights a reStructuredText %s directive",
  async (directive) => {
    const doc = await open(
      `.. ${directive}:: python\n\n   answer = 42`,
      "alias.rst",
    );
    const saved = required(nodes(doc.parsed.tree, "code")[0]);
    expect(saved.properties.dataLanguage).toBe("python");
    expect(text(saved)).toBe("answer = 42");
    expect(nodes(saved, "span").length).toBeGreaterThan(0);
  },
);

it("reuses reStructuredText adornment levels in order of first use", async () => {
  const doc = await open(
    "First\n=====\n\nSecond\n------\n\nThird\n=====\n",
    "levels.rst",
  );
  expect(doc.parsed.outline.map((item) => [item.depth, item.text])).toEqual([
    [1, "First"],
    [2, "Second"],
    [1, "Third"],
  ]);
});
