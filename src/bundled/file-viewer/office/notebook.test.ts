import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { Element, Nodes } from "hast";
import type { OfficeResult } from "../office-types";
import { required } from "./required";
type LoadedOffice = Extract<OfficeResult, { ok: true }>["office"];
import { MAX_RENDER_CHARS } from "../office-types";
import { openNotebook } from "./notebook";
import { openOffice } from "./load";
import { parseOfficeTree } from "../office-parse";

const signal = () => new AbortController().signal;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qS8AAAAASUVORK5CYII=";
const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const jpegBytes = unzipSync(
  new Uint8Array(
    readFileSync("src/bundled/file-viewer/fixtures/office/document-rich.docx"),
  ),
)["docProps/thumbnail.jpeg"];
const jpeg = btoa(String.fromCharCode(...required(jpegBytes)));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>alert(1)</script><rect width="20" height="10"/></svg>';
const markdown = (source: string | string[], extra = {}) => ({
  cell_type: "markdown",
  source,
  metadata: {},
  ...extra,
});
const code = (outputs: unknown[] = [], extra = {}) => ({
  cell_type: "code",
  source: ["x = ", "1\n"],
  execution_count: 7,
  metadata: {},
  outputs,
  ...extra,
});
const notebook = (cells: unknown[], extra = {}) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { language: "python" } },
  cells,
  ...extra,
});
async function result(saved: unknown, caller = signal()) {
  const bytes =
    typeof saved === "string"
      ? new TextEncoder().encode(saved)
      : saved instanceof Uint8Array
        ? saved
        : new TextEncoder().encode(JSON.stringify(saved));
  return openNotebook(bytes, caller);
}
async function open(
  saved: unknown,
): Promise<
  LoadedOffice & { doc: Extract<LoadedOffice["doc"], { family: "document" }> }
> {
  const loaded = await result(saved);
  if (
    !loaded.ok ||
    !("office" in loaded) ||
    loaded.office.doc.family !== "document"
  )
    throw new Error(`Expected notebook: ${JSON.stringify(loaded)}`);
  return loaded.office as LoadedOffice & {
    doc: Extract<LoadedOffice["doc"], { family: "document" }>;
  };
}
function all(root: Nodes): Nodes[] {
  const out: Nodes[] = [],
    stack = [root];
  while (stack.length) {
    const node = required(stack.pop());
    out.push(node);
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        stack.push(required(node.children[at]));
  }
  return out;
}
const elements = (root: Nodes, tag?: string): Element[] =>
  all(root).filter(
    (node): node is Element =>
      node.type === "element" && (!tag || node.tagName === tag),
  );
const text = (root: Nodes): string =>
  all(root)
    .filter((node) => node.type === "text")
    .map((node) => node.value)
    .join("");
const hasClass = (node: Element, name: string) =>
  Array.isArray(node.properties.className) &&
  node.properties.className.includes(name);
const tree = (loaded: Awaited<ReturnType<typeof open>>) =>
  loaded.doc.parsed.tree;

// These tests own the notebook projection boundary.
// Existing Markdown and raster suites own their general grammars/codecs; here
// the distinct risks are MIME priority, context isolation, source fidelity,
// media admission and cancellation at notebook's new lifecycle boundary.
describe("notebooks through Office projection", () => {
  it("reads Markdown, highlighted code, prompts and raw cells in saved order", async () => {
    const loaded = await open(
      notebook([
        markdown(["# Analysis\n\n", "**Kept**"]),
        code(),
        { cell_type: "raw", source: "<b>literal</b>", metadata: {} },
      ]),
    );
    expect(loaded.doc.parsed.kind).toBe("markdown");
    expect(loaded.doc.parsed.outline).toMatchObject([
      { depth: 1, text: "Analysis" },
    ]);
    expect(text(tree(loaded))).toContain("In [7]x = 1\n<b>literal</b>");
    expect(elements(tree(loaded), "strong").map(text)).toEqual(["Kept"]);
    expect(
      elements(tree(loaded), "code").some(
        (node) => node.properties.dataLanguage === "python",
      ),
    ).toBe(true);
    expect(elements(tree(loaded), "span").length).toBeGreaterThan(0);
    const fallback = await open(
      notebook([code()], { metadata: { language_info: { name: "sql" } } }),
    );
    expect(
      required(elements(tree(fallback), "code")[0]).properties.dataLanguage,
    ).toBe("sql");
  });

  const mimeValues: Record<string, unknown> = {
    "image/png": png,
    "image/jpeg": jpeg,
    "image/gif": gif,
    "image/svg+xml": [svg],
    "text/html": "<table><tr><th>Count</th><td>5</td></tr></table>",
    "text/markdown": "**Markdown**",
    "text/latex": "x^2",
    "application/json": { answer: 42 },
    "text/plain": "plain",
  };
  const order = Object.keys(mimeValues);
  it.each(order)(
    "uses saved %s ahead of every lower-priority representation",
    async (mime) => {
      const at = order.indexOf(mime),
        bundle = Object.fromEntries(
          order.slice(at).map((key) => [key, mimeValues[key]]),
        );
      const loaded = await open(
        notebook([
          code([
            {
              output_type: "execute_result",
              execution_count: 9,
              data: bundle,
              metadata: {},
            },
          ]),
        ]),
      );
      const output = required(
        elements(tree(loaded), "div").find((node) =>
          hasClass(node, "mdv-output"),
        ),
      );
      expect(text(output)).toContain("Out [9]");
      if (mime.startsWith("image/")) {
        expect(elements(output, "img")).toMatchObject([
          { properties: { src: "mdv-media:0" } },
        ]);
        expect([...loaded.media.values()].map((blob) => blob.type)).toEqual([
          mime,
        ]);
        expect(elements(output, "svg")).toHaveLength(0);
      } else if (mime === "text/html")
        expect(elements(output, "td").map(text)).toEqual(["5"]);
      else if (mime === "text/markdown")
        expect(elements(output, "strong").map(text)).toEqual(["Markdown"]);
      else if (mime === "text/latex")
        expect(required(elements(output, "code")[0])).toMatchObject({
          properties: { dataLanguage: "math" },
        });
      else if (mime === "application/json")
        expect(text(output)).toContain('{\n  "answer": 42\n}');
      else expect(text(output)).toContain("plain");
    },
  );

  it("renders HTML as sanitized HTML, preserving literal Markdown punctuation", async () => {
    const hostile =
      'Literal *stars*<script>BAD_SCRIPT</script><table onclick="bad()"><tr><td>value</td></tr></table><img src="javascript:alert(1)" onerror="bad()"><a href="javascript:alert(1)">link</a><iframe srcdoc="bad"></iframe>';
    const loaded = await open(
      notebook([
        code([
          {
            output_type: "display_data",
            data: { "text/html": hostile },
            metadata: {},
          },
        ]),
      ]),
    );
    expect(text(tree(loaded))).toContain("Literal *stars*");
    expect(elements(tree(loaded), "em")).toHaveLength(0);
    expect(elements(tree(loaded), "td").map(text)).toEqual(["value"]);
    expect(
      elements(tree(loaded)).every(
        (node) => !["script", "iframe"].includes(node.tagName),
      ),
    ).toBe(true);
    expect(JSON.stringify(tree(loaded))).not.toMatch(
      /BAD_SCRIPT|onerror|onclick|javascript:/,
    );
  });

  it("preserves streams and errors in order while removing CSI and OSC escapes", async () => {
    const loaded = await open(
      notebook([
        code([
          {
            output_type: "stream",
            name: "stdout",
            text: ["first\n", "\x1b[32mgreen\x1b[0m"],
          },
          {
            output_type: "stream",
            name: "stderr",
            text: "\x1b]0;title\x07warning\n",
          },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "bad",
            traceback: ["\x1b[31mline one\x1b[0m", "line two"],
          },
        ]),
      ]),
    );
    const outputs = elements(tree(loaded), "div").filter((node) =>
      hasClass(node, "mdv-output"),
    );
    expect(outputs.map(text)).toEqual([
      "first\ngreen",
      "warning\n",
      "ValueError: bad\nline one\nline two",
    ]);
    expect(
      elements(required(outputs[1]), "div").some((node) =>
        hasClass(node, "mdv-stderr"),
      ),
    ).toBe(true);
    expect(
      elements(required(outputs[2]), "div").some((node) =>
        hasClass(node, "mdv-error"),
      ),
    ).toBe(true);
    expect(text(tree(loaded))).not.toContain("\x1b");
  });

  it("embeds cell-local attachments without permitting forged internal references", async () => {
    const loaded = await open(
      notebook([
        markdown(
          '![logo](attachment:my%20logo.png)\n\n![again](attachment:my%20logo.png)\n\n![missing](attachment:no.png)\n\n<img src="mdv-media:0" alt="forged">',
          { attachments: { "my logo.png": { "image/png": [png] } } },
        ),
        markdown("![different cell](attachment:my%20logo.png)"),
      ]),
    );
    expect(loaded.media.size).toBe(1);
    expect(
      elements(tree(loaded), "img").map((node) => [
        node.properties.alt,
        node.properties.src,
      ]),
    ).toEqual([
      ["logo", "mdv-media:0"],
      ["again", "mdv-media:0"],
      ["missing", undefined],
      ["forged", undefined],
      ["different cell", undefined],
    ]);
  });

  it("keeps footnote definitions and backlinks independent between cells and outputs", async () => {
    const body = "Note[^same].\n\n[^same]: body";
    const loaded = await open(
      notebook([
        markdown(body),
        markdown(body),
        code([
          {
            output_type: "display_data",
            data: { "text/markdown": body },
            metadata: {},
          },
        ]),
      ]),
    );
    const nodes = elements(tree(loaded)),
      ids = nodes
        .map((node) => node.properties.id)
        .filter((id): id is string => typeof id === "string");
    expect(new Set(ids).size).toBe(ids.length);
    const links = elements(tree(loaded), "a").filter(
      (node) =>
        node.properties.dataFootnoteRef !== undefined ||
        node.properties.dataFootnoteBackref !== undefined,
    );
    expect(links).toHaveLength(6);
    for (const link of links)
      expect(ids).toContain(
        decodeURIComponent(String(link.properties.href).slice(1)),
      );
  });

  it("keeps local heading links bound to their own cell after global outlining", async () => {
    const loaded = await open(
      notebook([
        markdown("# Same\n\n[here](#same)"),
        markdown("# Same\n\n[here](#same)"),
      ]),
    );
    const headings = elements(tree(loaded), "h1").map(
      (node) => node.properties.id,
    );
    expect(new Set(headings).size).toBe(2);
    expect(
      elements(tree(loaded), "a").map((node) => node.properties.href),
    ).toEqual(headings.map((id) => `#${id}`));
    expect(loaded.doc.parsed.outline.map((item) => item.id)).toEqual(headings);
  });

  it("keeps JSON MIME numeric and escaped-string tokens exactly as saved", async () => {
    const saved =
      '{"nbformat":4,"cells":[{"cell_type":"code","source":"","outputs":[{"output_type":"display_data","data":{"application/json":{"n":1.0,"big":12345678901234567890,"s":"\\u0061\\\\\\""}}}]}]}';
    const loaded = await open(saved);
    expect(text(tree(loaded))).toContain('"n": 1.0');
    expect(text(tree(loaded))).toContain('"big": 12345678901234567890');
    expect(text(tree(loaded))).toContain('"s": "\\u0061\\\\\\""');
  });

  it("uses the final duplicated notebook properties for lexical JSON outputs", async () => {
    const loaded = await open(
      '{"nbformat":4,"cells":[],"cells":[{"cell_type":"code","source":"","outputs":[{"output_type":"display_data","data":{"application/json":0,"application/json":12345678901234567890}}]}]}',
    );
    expect(text(tree(loaded))).toContain("12345678901234567890");
  });

  it("turns oversized pictures into alt chips and accounts the whole notebook pixel budget", async () => {
    const large =
      '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"/>';
    const full =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096"/>';
    const loaded = await open(
      notebook([
        code([
          {
            output_type: "display_data",
            data: {
              "image/svg+xml": large,
              "text/plain": "do not choose a poorer MIME",
            },
          },
          ...Array.from({ length: 5 }, () => ({
            output_type: "display_data",
            data: { "image/svg+xml": full },
          })),
        ]),
      ]),
    );
    expect(loaded.media.size).toBe(4);
    expect(
      elements(tree(loaded), "img").map((node) => node.properties.src),
    ).toEqual([
      undefined,
      "mdv-media:0",
      "mdv-media:1",
      "mdv-media:2",
      "mdv-media:3",
      undefined,
    ]);
    expect(text(tree(loaded))).not.toContain("poorer MIME");
  });

  it("truncates at whole cell/output boundaries while retaining earlier output", async () => {
    const loaded = await open(
      notebook([
        markdown("# Retained"),
        code([
          { output_type: "stream", name: "stdout", text: "complete output" },
          {
            output_type: "stream",
            name: "stdout",
            text: "X".repeat(MAX_RENDER_CHARS),
          },
          { output_type: "stream", name: "stdout", text: "UNREACHED" },
        ]),
        markdown("AFTER_TRUNCATION"),
      ]),
    );
    expect(loaded.doc.truncated).toBe(true);
    expect(text(tree(loaded))).toContain("complete output");
    expect(text(tree(loaded))).not.toMatch(/X|UNREACHED|AFTER_TRUNCATION/);
    expect(
      elements(tree(loaded), "div").filter((node) =>
        hasClass(node, "mdv-output"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    "X".repeat(MAX_RENDER_CHARS + 1000),
    `\`\`\`python\n${"X".repeat(MAX_RENDER_CHARS + 1000)}\n\`\`\``,
    `- ${"X".repeat(MAX_RENDER_CHARS + 1000)}`,
  ])(
    "retains complete Markdown blocks before an oversized final block",
    async (finalBlock) => {
      const loaded = await open(
        notebook([
          markdown(`# Heading\n\nsmall paragraph\n\n${finalBlock}`),
          markdown("AFTER_CUT"),
        ]),
      );
      expect(loaded.doc.truncated).toBe(true);
      expect(elements(tree(loaded), "h1").map(text)).toEqual(["Heading"]);
      expect(elements(tree(loaded), "p").map(text)).toEqual([
        "small paragraph",
      ]);
      expect(text(tree(loaded))).not.toMatch(/X|AFTER_CUT/);
    },
  );

  it("does not expose headings inside front matter closed beyond the bounded prefix", async () => {
    const loaded = await open(
      notebook([
        markdown(
          "---\n\n# YAML content\n\n" +
            "X".repeat(MAX_RENDER_CHARS + 1000) +
            "\n---\n\nAFTER_YAML",
        ),
      ]),
    );
    expect(loaded.doc.truncated).toBe(true);
    expect(loaded.doc.parsed.outline).toEqual([]);
    expect(text(tree(loaded))).toBe("");
  });

  it("accounts cell/output wrappers in depth admission before whole-notebook sanitation", async () => {
    const nested = `${"<div>".repeat(98)}TOO_DEEP_OUTPUT${"</div>".repeat(98)}`;
    const loaded = await open(
      notebook([
        markdown("# Retained"),
        code([{ output_type: "display_data", data: { "text/html": nested } }]),
      ]),
    );
    expect(loaded.doc.truncated).toBe(true);
    expect(loaded.doc.parsed.kind).toBe("markdown");
    expect(loaded.doc.parsed.outline).toMatchObject([{ text: "Retained" }]);
    expect(text(tree(loaded))).not.toContain("TOO_DEEP_OUTPUT");
  });

  it.each([
    "{",
    JSON.stringify(notebook([], { nbformat: 3 })),
    JSON.stringify({ nbformat: 4, cells: {} }),
  ])("rejects malformed or old notebook input", async (saved) => {
    expect(await result(saved)).toMatchObject({
      ok: false,
      error: { code: "unreadable" },
    });
  });
  it("maps invalid UTF-8 to not-text and preserves caller cancellation", async () => {
    expect(await result(new Uint8Array([0xff]))).toMatchObject({
      ok: false,
      error: { code: "not-text" },
    });
    vi.useFakeTimers();
    try {
      const controller = new AbortController(),
        pending = result(
          notebook(Array.from({ length: 1000 }, () => markdown("hello"))),
          controller.signal,
        );
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      controller.abort();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves cancellation after notebook projection starts yielding between cells", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    let now = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (now += 13));
    try {
      const controller = new AbortController();
      const pending = result(
        notebook(Array.from({ length: 1000 }, () => markdown("cell content"))),
        controller.signal,
      );
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      // The initial paint fallback is 50 ms. Subsequent budget boundaries
      // yield tasks, allowing this caller input to interrupt projection.
      setTimeout(() => controller.abort(), 52);
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it("keeps notebook class admission private to the notebook path", () => {
    const parsed = parseOfficeTree({
      type: "root",
      children: [
        {
          type: "element",
          tagName: "div",
          properties: {
            className: [
              "mdv-cell",
              "mdv-prompt",
              "mdv-output",
              "mdv-stderr",
              "mdv-error",
            ],
          },
          children: [{ type: "text", value: "plain" }],
        },
      ],
    });
    expect(
      required(elements(parsed.tree, "div")[0]).properties.className ?? [],
    ).toEqual([]);
  });

  it("bounds deep HTML before the raw parser can perform quadratic tree building", async () => {
    const saved = notebook([
      code([
        {
          output_type: "display_data",
          data: {
            "text/html": `${"<div>".repeat(32_000)}text${"</div>".repeat(32_000)}`,
          },
        },
      ]),
    ]);
    const started = performance.now();
    await open(saved);
    // The formerly accepted 352KB payload blocked for ~8s. This generous
    // two-second ceiling protects user-visible responsiveness, not microseconds.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("admits namespace-qualified SVG roots accepted by the SVG validator", async () => {
    const prefixed =
      '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="20" height="10"><s:rect width="20" height="10"/></s:svg>';
    const loaded = await open(
      notebook([
        code([
          { output_type: "display_data", data: { "image/svg+xml": prefixed } },
        ]),
      ]),
    );
    expect(required(elements(tree(loaded), "img")[0]).properties.src).toBe(
      "mdv-media:0",
    );
    expect([...loaded.media.values()].map((blob) => blob.type)).toEqual([
      "image/svg+xml",
    ]);
  });

  it("reads validated XML prefixes/entities without folding dimension attribute case", async () => {
    const unicode =
      '<λ:svg xmlns:λ="http://www.w3.org/2000/svg" width="&#50;0" height="10"><λ:rect width="20" height="10"/></λ:svg>';
    const uppercase =
      '<svg xmlns="http://www.w3.org/2000/svg" WIDTH="4096" HEIGHT="4096"/>';
    const loaded = await open(
      notebook([
        code(
          [unicode, ...Array(5).fill(uppercase)].map((saved) => ({
            output_type: "display_data",
            data: { "image/svg+xml": saved },
          })),
        ),
      ]),
    );
    expect(loaded.media.size).toBe(6);
    expect(
      elements(tree(loaded), "img").every(
        (node) => typeof node.properties.src === "string",
      ),
    ).toBe(true);
    for (const invalid of [
      '<s:svg width="20" height="10"/>',
      '<s:html xmlns:s="http://www.w3.org/2000/svg" width="20" height="10"/>',
    ]) {
      const rejected = await open(
        notebook([
          code([
            { output_type: "display_data", data: { "image/svg+xml": invalid } },
          ]),
        ]),
      );
      expect(rejected.media.size).toBe(0);
      expect(
        required(elements(tree(rejected), "img")[0]).properties.src,
      ).toBeUndefined();
    }
  });

  it("admits broad shallow HTML using the same fragment parser states", async () => {
    const html =
      "<table><tr><td>A</td><td>B</td></tr></table>" +
      "<p><b>wide</b></p>".repeat(10_000);
    const loaded = await open(
      notebook([
        code([{ output_type: "display_data", data: { "text/html": html } }]),
      ]),
    );
    expect(loaded.doc.truncated).toBeUndefined();
    expect(elements(tree(loaded), "p")).toHaveLength(10_000);
    expect(elements(tree(loaded), "td").map(text)).toEqual(["A", "B"]);
  });

  it("omits only generated footnote headings from the global notebook outline", async () => {
    const loaded = await open(
      notebook([
        markdown(
          '# Footnotes\n\n<h2 id="footnote-label">Footnotes</h2>\n\nNote[^a].\n\n[^a]: body',
        ),
        markdown("# Other\n\nNote[^a].\n\n[^a]: second"),
      ]),
    );
    expect(loaded.doc.parsed.outline.map((item) => item.text)).toEqual([
      "Footnotes",
      "Footnotes",
      "Other",
    ]);
    const ids = elements(tree(loaded)).map((node) => node.properties.id);
    const generatedLabels = elements(tree(loaded), "h2").filter(
      (node) => text(node) === "Footnotes",
    );
    expect(generatedLabels).toHaveLength(3);
    for (const label of generatedLabels)
      expect(label.properties.id).toBeTruthy();
    for (const link of elements(tree(loaded), "a"))
      if (String(link.properties.href).startsWith("#"))
        expect(ids).toContain(
          decodeURIComponent(String(link.properties.href).slice(1)),
        );
  });
});

// Routing is distinct from the projection tests above: textual Office formats
// must be dispatched before ZIP/CFB sniffing, including MIME-only uploads.
it.each([
  [
    "upload",
    "application/x-ipynb+json",
    JSON.stringify(notebook([markdown("# Notebook")])),
  ],
  ["upload", "text/x-rst", "Heading\n=======\n\nSaved."],
  ["upload", "text/asciidoc", "= Heading\n\nSaved."],
  ["upload", "application/x-tex", String.raw`\section{Heading} Saved.`],
])(
  "routes MIME-only %s %s through its Office document reader",
  async (name, mime, saved) => {
    const loaded = await openOffice(
      new TextEncoder().encode(saved),
      name,
      signal(),
      { mime },
    );
    expect(loaded).toMatchObject({
      ok: true,
      office: { doc: { family: "document", parsed: { kind: "markdown" } } },
    });
  },
);
