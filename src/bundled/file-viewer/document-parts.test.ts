import { MAX_RENDER_CHARS, required } from "./markdown-limits";
import { containerDefinitions } from "./markdown-container-definitions";
import { fenceLine } from "./markdown-fences";
import { describe, expect, it } from "vitest";
import { rehypeFileMarkdown } from "./file-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Root, Element } from "hast";
import {
  indexDocument,
  indexData,
  documentParts,
  PART_CHARS,
  remarkPartHeadings,
  rehypePartFootnotes,
} from "./document-parts";

function rendered(
  parts: ReturnType<typeof indexDocument>,
  index: number,
): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkPartHeadings(parts, index))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePartFootnotes(parts, index))
    .use(rehypeFileMarkdown);
  const source = parts.partSource(index);
  return processor.runSync(processor.parse(source), { value: source }) as Root;
}
function elements(tree: Root): Element[] {
  const found: Element[] = [];
  const stack: (Root | Element)[] = [tree];
  while (stack.length)
    for (const child of required(stack.pop()).children)
      if (child.type === "element") {
        found.push(child);
        stack.push(child);
      }
  return found;
}
function textOf(node: Root | Element): string {
  return node.children
    .map((child) =>
      "value" in child
        ? child.value
        : child.type === "element"
          ? textOf(child)
          : "",
    )
    .join("");
}

describe("bounded document parts", () => {
  it.each(["markdown", "code", "text"] as const)(
    "keeps exact scalar and CRLF boundaries and physical lines for %s",
    (kind) => {
      const text =
        "a".repeat(PART_CHARS - 1) +
        "😀\r\n" +
        "b".repeat(PART_CHARS * 2) +
        "\r\nlast";
      const indexed = indexDocument(text, kind);
      expect(
        indexed.parts.map((part) => text.slice(part.start, part.end)).join(""),
      ).toBe(text);
      for (const part of indexed.parts) {
        expect(part.end - part.start).toBeLessThanOrEqual(PART_CHARS);
        expect(part.line).toBe(
          1 + [...text.slice(0, part.start).matchAll(/\r\n|\r|\n/g)].length,
        );
        expect(text.slice(part.start, part.end)).not.toMatch(
          /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
        );
        expect(text.slice(part.start, part.end)).not.toMatch(/^\n|\r$/);
      }
      expect(indexDocument("", kind).parts).toEqual([
        { start: 0, end: 0, line: 1 },
      ]);
    },
  );

  it("assigns global heading IDs by source offset and indexes rendered container/setext headings", () => {
    const text =
      "# User content files\n\n#### Repeat\n\n# Repeat\n\n> ## Quoted *heading*\n\n- ### Listed\n\n  ### Indented\n\nSetext &amp; `code`\n===\n\n" +
      "paragraph\n\n".repeat(2000) +
      "# Files\n\n# Repeat\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => [item.text, item.id])).toEqual([
      ["User content files", "user-content-files"],
      ["Repeat", "repeat-1"],
      ["Quoted heading", "quoted-heading"],
      ["Listed", "listed"],
      ["Indented", "indented"],
      ["Setext & code", "setext--code"],
      ["Files", "files"],
      ["Repeat", "repeat-2"],
    ]);
    for (let i = 0; i < indexed.parts.length; i++) {
      const ids = elements(rendered(indexed, i))
        .filter((node) => /^h[1-6]$/.test(node.tagName))
        .map((node) => node.properties.id);
      for (const heading of indexed.outline.filter((item) => item.part === i))
        expect(ids).toContain(`user-content-${heading.id}`);
    }
    expect(indexed.partOf("#user-content-files")).toBe(0);
    expect(indexed.partOf("#files")).toBe(indexed.parts.length - 1);
    expect(indexed.partOf("#user-content-user-content-files")).toBe(0);
    expect(indexed.partOf("user-content-repeat-2")).toBe(
      indexed.parts.length - 1,
    );
  });

  it("carries a container-owned fence without interpreting its payload as headings", () => {
    const text = `> - \`\`\`ts\n${">   # literal\n".repeat(1600)}>   \`\`\`\n\n# Visible\n`;
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual(["Visible"]);
    expect(
      indexed.parts.slice(1).some((part) => part.fence !== undefined),
    ).toBe(true);
    for (let i = 0; i < indexed.parts.length; i++) {
      const nodes = elements(rendered(indexed, i));
      expect(
        nodes.filter((node) => node.tagName === "h1").map(textOf),
      ).not.toContain("literal");
      expect(textOf(rendered(indexed, i))).not.toContain("\uE000");
    }
  });

  it("preserves first definitions and builds local footnotes with canonical navigation", () => {
    for (const [owner, noteOwner] of [
      ["> ", "> "],
      [">\t", ">\t"],
      ["- ", "  "],
      ["- ", "- "],
    ] as const) {
      const duplicate = indexDocument(
        `[^n]: First definition.\n\n${"paragraph\n\n".repeat(1500)}${noteOwner.trim() ? noteOwner : owner}[^n]: Later definition.\n\nCall[^n].\n`,
        "markdown",
      );
      const duplicateNotes = elements(
        rendered(duplicate, duplicate.parts.length - 1),
      )
        .filter((node) => node.tagName === "li")
        .map(textOf)
        .join("");
      expect(duplicateNotes).toContain("First definition.");
      expect(duplicateNotes).not.toContain("Later definition.");
      const source = `${owner}[site]: https://example.org/first\n${noteOwner}[^n]: Footnote\n${owner.startsWith(">") ? ">     " : "      "}continued [site].\n\n${"paragraph\n\n".repeat(1500)}[site]: https://example.org/later\n\nRead [site] and note[^n].\n`;
      const parts = indexDocument(source, "markdown"),
        last = elements(rendered(parts, parts.parts.length - 1));
      expect(
        last.some(
          (node) => node.properties.href === "https://example.org/first",
        ),
      ).toBe(true);
      expect(
        last.some(
          (node) => node.properties.href === "https://example.org/later",
        ),
      ).toBe(false);
      expect(
        last
          .filter((node) => node.tagName === "li")
          .map(textOf)
          .join(""),
      ).toContain("Footnote\ncontinued");
    }
    const text =
      "[site]: https://example.org/first\n\nFirst [site] and other[^other], then note[^n].\n\n" +
      "paragraph\n\n".repeat(1400) +
      "[site]: https://example.org/later\n\n# Later\nSecond [site] and note[^n].\n\n[^n]: Definition [site] and nested[^other].\n[^other]: Cycle[^n].\n";
    const indexed = indexDocument(text, "markdown");
    const first = elements(rendered(indexed, 0));
    const lastIndex = indexed.parts.length - 1,
      last = elements(rendered(indexed, lastIndex));
    expect(
      first
        .filter((node) => node.tagName === "a")
        .some((node) => node.properties.href === "https://example.org/first"),
    ).toBe(true);
    expect(
      last
        .filter((node) => node.tagName === "a")
        .some((node) => node.properties.href === "https://example.org/later"),
    ).toBe(false);
    expect(
      first.some((node) => node.properties.id === "user-content-fn-n"),
    ).toBe(true);
    expect(
      last.some(
        (node) => node.properties.id === `user-content-fn-n-part-${lastIndex}`,
      ),
    ).toBe(true);
    expect(
      last.some(
        (node) =>
          node.properties.id === `user-content-fn-other-part-${lastIndex}`,
      ),
    ).toBe(true);
    expect(
      Number(
        last.find(
          (node) =>
            node.properties.id === `user-content-fn-n-part-${lastIndex}`,
        )?.properties.value,
      ),
    ).toBe(2);
    expect(indexed.partOf(`user-content-fn-n-part-${lastIndex}`)).toBe(
      lastIndex,
    );
    expect(indexed.partOf(`user-content-fnref-n-2-part-${lastIndex}`)).toBe(
      lastIndex,
    );
    expect(
      indexed.partOf(`user-content-fnref-n-999-part-${lastIndex}`),
    ).toBeUndefined();
    expect(
      indexed.partOf(`user-content-fn-n-part-${indexed.parts.length}`),
    ).toBeUndefined();
    expect(indexed.partFallback(lastIndex)).toBeUndefined();
  });

  it("keeps CommonMark HTML suppression and hides comment continuations", () => {
    const text =
      "<div>\n" +
      "# hidden\n".repeat(2000) +
      "\n# Visible\n\n<!--\n" +
      "# comment\n".repeat(1600) +
      "-->\n\n# End\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "Visible",
      "End",
    ]);
    const outputs = indexed.parts.map((_, index) =>
      textOf(rendered(indexed, index)),
    );
    expect(outputs.join("")).toContain("# hidden");
    expect(outputs.join("")).not.toContain("# comment");
    expect(outputs.join("")).not.toContain("<div>");
    expect(outputs.join("")).toContain("Visible");
    expect(outputs.join("")).toContain("End");
  });

  it("preserves raw table structure and attributes through line and token cuts", () => {
    const text =
      '<table id="inventory" align="center"><tbody>\n' +
      Array.from(
        { length: 700 },
        (_, index) =>
          `<tr><td colspan="2">row-${index}</td><td>value</td></tr>\n`,
      ).join("") +
      "</tbody></table>\n\n# End\n";
    const indexed = indexDocument(text, "markdown");
    const rows: string[] = [];
    for (let part = 0; part < indexed.parts.length; part++) {
      expect(indexed.partFallback(part)).toBeUndefined();
      expect(
        required(indexed.parts[part]).end - required(indexed.parts[part]).start,
      ).toBeLessThanOrEqual(PART_CHARS);
      const nodes = elements(rendered(indexed, part));
      const table = nodes.find((node) => node.tagName === "table");
      if (table) expect(table.properties.align).toBe("center");
      rows.push(...nodes.filter((node) => node.tagName === "tr").map(textOf));
      for (const cell of nodes.filter(
        (node) => node.tagName === "td" && textOf(node).startsWith("row-"),
      ))
        expect(cell.properties.colSpan).toBe("2");
    }
    expect(rows.sort()).toEqual(
      Array.from({ length: 700 }, (_, index) => `row-${index}value`).sort(),
    );
    expect(indexed.partOf("inventory")).toBe(0);
    expect(
      indexed.parts
        .flatMap((_, part) => elements(rendered(indexed, part)))
        .filter((node) => node.properties.id === "inventory"),
    ).toHaveLength(1);

    const inline = indexDocument(
      '<table><tr><td id="long-cell">' +
        "x".repeat(PART_CHARS * 2) +
        "</td></tr></table>",
      "markdown",
    );
    for (let part = 0; part < inline.parts.length; part++) {
      expect(inline.partFallback(part)).toBeUndefined();
      expect(
        elements(rendered(inline, part)).some((node) => node.tagName === "td"),
      ).toBe(true);
    }
    expect(
      inline.parts.map((_, part) => textOf(rendered(inline, part))).join(""),
    ).toBe("x".repeat(PART_CHARS * 2));
  });

  it("continues details and optional list items while letting Markdown resume after blanks", () => {
    const text =
      '<details id="more" open><summary>More</summary>\n\n' +
      "paragraph with **bold**.\n\n".repeat(900) +
      "</details>\n\n" +
      '<ol reversed type="A">\n' +
      Array.from({ length: 600 }, (_, index) => `<li>item-${index}\n`).join(
        "",
      ) +
      "</ol>\n";
    const indexed = indexDocument(text, "markdown");
    const trees = indexed.parts.map((_, part) => rendered(indexed, part));
    expect(
      trees
        .map(textOf)
        .join("")
        .match(/paragraph with bold\./g),
    ).toHaveLength(900);
    expect(
      trees.flatMap(elements).filter((node) => node.tagName === "li"),
    ).toHaveLength(600);
    expect(
      trees
        .flatMap(elements)
        .filter((node) => node.tagName === "li")
        .map(textOf)
        .join("")
        .match(/item-\d+/g),
    ).toHaveLength(600);
    for (const list of trees
      .flatMap(elements)
      .filter((node) => node.tagName === "ol"))
      expect(list.properties).toMatchObject({ reversed: true, type: "A" });
    expect(
      trees.flatMap(elements).filter((node) => node.properties.id === "more"),
    ).toHaveLength(1);
  });

  it("routes kept raw IDs to their first actual owner and ignores literal or removed IDs", () => {
    const text =
      '# Earlier\n\nCall[^n].\n\n[^n]: note\n\n<div id="raw&amp;id">first</div>\n\n' +
      '`<b id="code-span">literal</b>`\n\n\\<b id="escaped">literal\n\n' +
      '    <b id="indented-code">literal</b>\n\n' +
      '```html\n<div id="fenced">literal</div>\n```\n\n' +
      '<!-- <b id="comment">hidden</b> -->\n\n<script id="script">hidden</script>\n\n' +
      '<b name="named">name</b>\n\n' +
      "paragraph\n\n".repeat(1500) +
      '<div id="raw&amp;id">duplicate</div>\n\n<h2 id="raw-heading">Raw heading</h2>\n\n' +
      '<div id="user-content-earlier">later duplicate</div>\n\n<div id="fn-n">raw target</div>\n\n# Later\n';
    const indexed = indexDocument(text, "markdown");
    expect(indexed.partOf("#raw%26id")).toBe(0);
    expect(indexed.partOf("user-content-earlier")).toBe(0);
    expect(indexed.partOf("raw-heading")).toBe(indexed.parts.length - 1);
    expect(indexed.partOf("fn-n")).toBe(indexed.parts.length - 1);
    expect(indexed.partOf("user-content-fn-n")).toBe(0);
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "Earlier",
      "Later",
    ]);
    for (const id of [
      "code-span",
      "escaped",
      "indented-code",
      "fenced",
      "comment",
      "script",
      "named",
    ])
      expect(indexed.partOf(id), id).toBeUndefined();
  });

  it("uses literal context fallbacks for oversized HTML tokens and deep ancestors", () => {
    const longToken = `<div title="${"x".repeat(PART_CHARS * 2)}">body</div>`;
    const indexed = indexDocument(longToken, "markdown");
    expect(
      indexed.parts.some((_, part) => indexed.partFallback(part) === "context"),
    ).toBe(true);
    for (let part = 0; part < indexed.parts.length; part++) {
      const range = required(indexed.parts[part]);
      expect(textOf(rendered(indexed, part))).toContain(
        longToken.slice(range.start, range.end),
      );
    }
    const deep = indexDocument(
      "<div>".repeat(101) + "text".repeat(PART_CHARS) + "</div>".repeat(101),
      "markdown",
    );
    expect(deep.partFallback(0)).toBe("too-deep");
    expect(textOf(rendered(deep, 0))).toContain("<div>");
  });

  it.each([
    ["PI", "<?target", "?>", false],
    ["CDATA", "<![CDATA[", "]]>", false],
    ["declaration", "<!DOCTYPE", ">", false],
    ["visible PI", "<?target >", "?>", true],
    ["visible CDATA", "<![CDATA[>", "]]>", true],
  ] as const)(
    "preserves explicit %s HTML through part boundaries",
    (_kind, opening, closing, visible) => {
      const payload = "# hidden\n\n~~~\n1. literal item\n\n".repeat(600);
      const indexed = indexDocument(
        `${opening}\n${payload}${closing}\n\n# After\n`,
        "markdown",
      );
      expect(indexed.outline.map((item) => item.text)).toEqual(["After"]);
      const trees = indexed.parts.map((_, part) => {
        expect(indexed.partFallback(part)).toBeUndefined();
        return rendered(indexed, part);
      });
      expect(
        trees
          .flatMap(elements)
          .filter((node) => ["li", "pre"].includes(node.tagName)),
      ).toHaveLength(0);
      const output = trees.map(textOf).join("");
      if (visible) expect(output).toContain(payload);
      else expect(output).not.toContain("literal item");
      expect(output).toContain("After");
    },
  );

  it.each([
    ["quote", "> ", "> ", "blockquote", "div"],
    ["quote pre", "> ", "> ", "blockquote", "pre"],
    ["list", "- ", "  ", "li", "div"],
    ["list pre", "- ", "  ", "li", "pre"],
  ] as const)(
    "keeps raw HTML inside its reconstructed %s owner",
    (_label, opening, continuation, owner, tag) => {
      for (const midline of [false, true]) {
        const payload = midline
          ? `${continuation}${"token ".repeat(6000)}\n`
          : `${continuation}token\n`.repeat(4000);
        const text = `${opening}<${tag}>\n${payload}${continuation}</${tag}>\n\n# End`;
        const indexed = indexDocument(text, "markdown");
        const outputs: string[] = [];
        for (let part = 0; part < indexed.parts.length; part++) {
          expect(indexed.partFallback(part)).toBeUndefined();
          const tree = rendered(indexed, part);
          const output = textOf(tree);
          outputs.push(output);
          expect(output).not.toMatch(/[>\uE000]/);
          if (output.includes("token")) {
            const container = elements(tree).find(
              (node) => node.tagName === owner,
            );
            expect(
              container,
              `${_label}, midline=${midline}, part=${part}`,
            ).toBeDefined();
            expect(
              elements({ type: "root", children: [required(container)] }).some(
                (node) => node.tagName === tag,
              ),
            ).toBe(true);
            expect(textOf(required(container))).toContain("token");
          }
        }
        expect(outputs.join("").replace(/\s/g, "")).toBe(
          `${"token".repeat(midline ? 6000 : 4000)}End`,
        );
      }
    },
  );

  it("treats frontmatter, math and emoji with the installed SafeMarkdown semantics", () => {
    const indexed = indexDocument(
      "---\n# YAML heading\n---\n\n$$\n# Math heading\n$$\n\n# :sparkles:\n",
      "markdown",
    );
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "YAML heading",
      "Math heading",
      ":sparkles:",
    ]);
  });
  it("keeps setext headings with their underline at a part seam", () => {
    const text =
      "paragraph\n\n".repeat(600) +
      "First line\nsecond line\n===\n\n" +
      "paragraph\n\n".repeat(1300);
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "First line\nsecond line",
    ]);
    const item = required(indexed.outline[0]);
    expect(
      elements(rendered(indexed, item.part)).some(
        (node) => node.properties.id === `user-content-${item.id}`,
      ),
    ).toBe(true);
  });

  it("normalizes long formatted labels without parsing an unbounded heading", () => {
    const title =
      "label ".repeat(100) +
      "*emphasis* and `*code*` &amp; [site](https://example.org)";
    const indexed = indexDocument(`# ${title}\n`, "markdown");
    expect(indexed.outline[0]?.text).toBe(
      `${"label ".repeat(100)}emphasis and *code* & site`,
    );
  });

  it("ends HTML suppression when its quote owner ends and retains imported note HTML", () => {
    const text =
      "> <div>\n" +
      "> # hidden\n".repeat(1800) +
      "\n# Visible\n\nCall[^n].\n\n" +
      "paragraph\n\n".repeat(1200) +
      "[^n]: Literal <b>HTML</b>.\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual(["Visible"]);
    const caller = indexed.parts.findIndex((part) =>
      text.slice(part.start, part.end).includes("Call[^n]"),
    );
    expect(textOf(rendered(indexed, caller))).toContain("Literal HTML.");
    for (let at = 1; at < indexed.parts.length; at++)
      expect(
        elements(rendered(indexed, at))
          .filter((node) => /^h[1-6]$/.test(node.tagName))
          .map(textOf),
      ).not.toContain("hidden");
  });

  it("routes encoded footnote identifiers and keeps code-only notes unreferenced", () => {
    const suffixed = indexDocument(
      `First[^z].\n\n${"paragraph\n\n".repeat(1500)}Second[^n-part-1].\n\n[^z]: Z\n[^n-part-1]: N\n`,
      "markdown",
    );
    const suffixNodes = elements(rendered(suffixed, suffixed.parts.length - 1));
    expect(
      suffixNodes
        .filter((node) => node.properties.dataFootnoteRef !== undefined)
        .map(textOf),
    ).toEqual(["2"]);
    expect(
      suffixNodes.find((node) => node.tagName === "li")?.properties.value,
    ).toBe("2");
    const text =
      "`[^unused]` <!-- [^unused] --> Call[^é].\n\n" +
      "paragraph\n\n".repeat(1300) +
      "Again[^é].\n\n[^é]: Unicode.\n[^unused]: Hidden.\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.partOf("user-content-fn-%C3%A9")).toBe(0);
    expect(indexed.partOf("fnref-%C3%A9-part-1")).toBe(1);
    expect(indexed.partOf("fn-unused")).toBeUndefined();
    expect(textOf(rendered(indexed, 0))).not.toContain("Hidden.");
  });

  it("bounds container projection without accepting a synthetic end of input", () => {
    const tail = `\n\n${"paragraph\n\n".repeat(1500)}`;
    const owner = "> ".repeat(40),
      label = Array.from({ length: 70 }, () => "x").join("\n");
    const labelSource = `${owner}[${label.replace(/\n/g, `\n${owner}`)}]: https://example.org/label${tail}[${label.replace(/\n/g, " ")}]\n`;
    const titleSource = `> [site]: https://example.org/title\n> "${"title\n> ".repeat(1000)}end"${tail}[site]\n`;
    const shortSource = `> [site]: https://example.org/short\n> ${"plain prose ".repeat(100_000)}${tail}[site]\n`;
    const manySource = `${Array.from({ length: 2000 }, (_, at) => `> [entry-${at}]: https://example.org/${at}\n`).join("")}${tail}[entry-1] [entry-1999]\n`;
    for (const [source, expected, title] of [
      [labelSource, ["https://example.org/label"], undefined],
      [
        titleSource,
        ["https://example.org/title"],
        `${"title\n".repeat(1000)}end`,
      ],
      [shortSource, ["https://example.org/short"], undefined],
      [
        manySource,
        ["https://example.org/1", "https://example.org/1999"],
        undefined,
      ],
    ] as const) {
      const indexed = indexDocument(source, "markdown"),
        last = indexed.parts.length - 1;
      expect(indexed.partFallback(last)).toBeUndefined();
      const links = elements(rendered(indexed, last)).filter(
        (node) => node.tagName === "a",
      );
      expect(links.map((node) => node.properties.href)).toEqual(expected);
      expect(links.map((node) => node.properties.title)).toEqual(
        expected.map(() => title),
      );
    }
    let charges = 0;
    const firstLine = required(titleSource.split("\n")[0]),
      first = fenceLine(firstLine, { owners: [] });
    const reader = containerDefinitions(titleSource, {
      exhausted: false,
      charge() {
        charges++;
        return true;
      },
    });
    expect(
      reader.contained?.(0, first.bodyOffset, first.after, first.bodyPadding)
        ?.label,
    ).toBe("SITE");
    expect(charges).toBe(1);
    const oversized = indexDocument(
      `> [site]: https://example.org/large\n> "${"x".repeat(MAX_RENDER_CHARS)}"${tail}[site]\n`,
      "markdown",
    );
    expect(oversized.partFallback(0)).toBe("too-large");
    const opening = '> [site]: https://example.org/invalid "';
    const invalid = indexDocument(
      `${opening}${"x".repeat(4096 - opening.length - 1)}" trailing${tail}[site]\n`,
      "markdown",
    );
    expect(
      elements(rendered(invalid, invalid.parts.length - 1)).filter(
        (node) => node.tagName === "a",
      ),
    ).toHaveLength(0);
  });

  it("reports admitted-size fallback and renders literal source without a delimiter escape", () => {
    for (const [prefix, nesting] of [
      ["", 6000],
      [`${"paragraph\n\n".repeat(1300)}safe\n\n`, 600],
    ] as const) {
      const source = `${prefix}${"> ".repeat(nesting)}word\n`;
      const parts = indexDocument(source, "markdown");
      const at = parts.parts.findIndex((part) => part.end === source.length);
      if (prefix)
        expect(required(parts.parts[at]).start).toBeLessThan(prefix.length);
      expect(() => rendered(parts, at)).not.toThrow();
      expect(parts.partFallback(at)).toBe("too-deep");
      expect(
        elements(rendered(parts, at))
          .filter((node) => node.tagName === "code")
          .map(textOf),
      ).toEqual([source.slice(required(parts.parts[at]).start)]);
    }
    const noteSource = `Call[^deep].\n\n${"paragraph\n\n".repeat(1500)}[^deep]: ${"> ".repeat(6000)}word\n`;
    const noteParts = indexDocument(noteSource, "markdown");
    expect(noteParts.partFallback(0)).toBe("too-deep");
    expect(() => rendered(noteParts, 0)).not.toThrow();
    const definition = `[^n]: ${"value ".repeat(170_000)}\n`;
    const text =
      "Use[^n].\n\n```literal\n```\n\n" +
      "paragraph\n\n".repeat(1400) +
      definition;
    const indexed = indexDocument(text, "markdown");
    expect(indexed.partFallback(0)).toBe("too-large");
    const part = required(indexed.parts[0]);
    expect(
      elements(rendered(indexed, 0))
        .filter((node) => node.tagName === "code")
        .map(textOf),
    ).toEqual([text.slice(part.start, part.end)]);
  });
});

it("rebuilds the worker index with distant references and whole-file anchors", () => {
  const source =
    "[site] Call[^n].\n\n" +
    "paragraph\n\n".repeat(1800) +
    '<span id="raw-target">Raw</span>\n\n# Late\n\n[site]: https://example.org/site\n[^n]: A distant note.\n';
  const data = structuredClone(indexData(source, "markdown"));
  const parts = documentParts(source, data);
  expect(parts.outline).toEqual([
    { depth: 1, text: "Late", id: "late", part: parts.parts.length - 1 },
  ]);
  expect(parts.partOf("#late")).toBe(parts.parts.length - 1);
  expect(parts.partOf("#raw-target")).toBe(parts.parts.length - 1);
  const first = elements(rendered(parts, 0));
  expect(
    first
      .filter((node) => node.tagName === "a")
      .map((node) => node.properties.href),
  ).toContain("https://example.org/site");
  expect(textOf(rendered(parts, 0))).toContain("A distant note.");
});

it("counts Unicode Markdown words while plain files skip reading metadata", () => {
  const source = "hello-world café 你好 123 can't a--b 𐐀𐐁\n";
  expect(indexDocument(source, "markdown").words).toBe(8);
  for (const kind of ["code", "text"] as const)
    expect(indexDocument(source, kind).words).toBe(0);
});
