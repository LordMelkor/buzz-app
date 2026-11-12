// @vitest-environment jsdom
import * as React from "react";
import { it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageMarkdown } from "../../../features/messages/MessageMarkdown";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";
import { serializeNode } from "../../../features/messages/selection-copy";
import { emptyReferenceDirectory } from "../../../features/messages/ReferenceText";
import { indexMessage, fenceMode } from "../engine/detect";
import { tool } from "../engine/tool";
import { createFence } from "./codeblock";
import { render as draw } from "../engine/render";
import { createInline } from "./inline";
import { styles } from "./styles";
import type { Engine } from "../contract";
import { required } from "../required";

// The real host message renderer and copy serializer, with the real
// index/render functions. Font installation,
// Expand chrome are outside this copy check; one case supplies cached profiles.
const NoExpand = () => null;
const factory: (
  react: typeof React,
  engine: Engine,
  expand: typeof NoExpand,
  directory: () => undefined,
) => ReturnType<typeof createInline> = createInline;
const engine = { index: indexMessage, render: draw, fenceMode } as Engine;
const inline = factory(React, engine, NoExpand, () => undefined);
const fence = createFence(React, engine, NoExpand);
const blocks = [
  { ...fence, key: "math/fence-review", pluginId: "math", revision: "1" },
];
const codeBlocks = { snapshot: () => blocks, subscribe: () => () => {} };
const entries = [
    { ...inline, key: "math/copy-review", pluginId: "math", revision: "1" },
  ],
  empty: never[] = [];
const registry = { snapshot: () => entries, subscribe: () => () => {} };
let style: HTMLStyleElement;
beforeEach(() => {
  style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
});
afterEach(() => {
  cleanup();
  style.remove();
});

function mountMessage(source: string, withMath = true) {
  const view = render(
    <ToastProvider>
      <MessageMarkdown
        row={{
          id: "copy-review",
          channelId: "fixture",
          authorId: "fixture-author",
          createdAt: 1,
          content: source,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        extensions={
          withMath
            ? {
                inline: registry,
                codeBlocks,
                tools: { snapshot: () => empty, subscribe: () => () => {} },
              }
            : undefined
        }
        media={() => undefined}
        onOpenLink={() => false}
      />
    </ToastProvider>,
  );
  return view.container;
}
function mountSource(source: string, withMath = true) {
  return required(mountMessage(source, withMath).querySelector("p"));
}
function copyThroughComposer(paragraph: HTMLElement) {
  const text = serializeNode(paragraph, "text"),
    html = serializeNode(paragraph, "html");
  const paste = document.createElement("div");
  paste.setAttribute("data-buzz-copy", "timeline");
  paste.innerHTML = html;
  return { text, html, markdown: serializeNode(paste, "markdown") };
}

it("typesets math beside parser-normalized NUL without changing raw source offsets", () => {
  const body = mountMessage("before\0 $x$ after");
  expect(body.querySelectorAll(".bzm-math .katex")).toHaveLength(1);
  expect(copyThroughComposer(body).text).toBe("before\uFFFD $x$ after");
});
it.each(["$$\nx\n$$\n\n$$\nx\n$$", "**$$\nx\n$$**\n\n**$$\nx\n$$**"])(
  "mounts two independent drawings and copies both repeated displays: %s",
  (source) => {
    const body = mountMessage(source);
    expect(body.querySelectorAll(".bzm-display .katex-display")).toHaveLength(
      2,
    );
    expect(copyThroughComposer(body).text).toBe(source.replaceAll("**", ""));
  },
);
it.each(["verb", "verb*"])(
  "typesets and native-copies environment tokens inside %s",
  (command) => {
    const source = `\\begin{align}\na&=\\${command}|\\begin{align}|\n\\end{align}`,
      body = mountMessage(source);
    expect(body.querySelectorAll(".bzm-display .katex-display")).toHaveLength(
      1,
    );
    expect(copyThroughComposer(body).text).toBe(source);
  },
);
it.each([
  "\\begin{equation}x=y\\end{equation}\rAfter",
  "\\begin{align}\ra&=b\r\\end{align}\rAfter",
])(
  "typesets CR-ended environments without hiding following prose: %s",
  (source) => {
    const body = mountMessage(source);
    expect(body.querySelectorAll(".bzm-display .katex-display")).toHaveLength(
      1,
    );
    expect(copyThroughComposer(body).text).toBe(source.replaceAll("\r", "\n"));
  },
);
it("keeps the declined bold bare environment native, while bold dollars typeset", () => {
  const native = mountMessage(
    String.raw`**\begin{equation}x=1\end{equation}**`,
  );
  expect(
    native.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap"),
  ).toHaveLength(0);
  expect(
    mountMessage("**$$x=1$$**").querySelectorAll(".bzm-display .katex-display"),
  ).toHaveLength(1);
});

it.each([
  String.raw`http\://localhost:3000`,
  String.raw`https\://my-host:3000`,
  String.raw`HTTPS\://localhost`,
  "abchttps&colon;//example.test",
])(
  "leaves decoded bare-link bodies fully native instead of orphaning hide pieces: %s",
  (url) => {
    const equation = `${url} $$\nx+y\n$$`;
    for (const source of [equation, `${equation}\n\n $$\na+b\n$$`]) {
      const body = mountMessage(source),
        native = mountMessage(source, false);
      expect(
        body.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap,.bzm-src"),
      ).toHaveLength(0);
      expect(copyThroughComposer(body)).toEqual(copyThroughComposer(native));
    }
  },
);
it("keeps math beside an ordinary GFM bare link typeset", () => {
  const source = "see https://example.com for $x$\n$$\ny\n$$",
    body = mountMessage(source);
  expect(body.querySelectorAll(".bzm-math,.bzm-display")).toHaveLength(2);
  expect(copyThroughComposer(body).text).toContain("for $x$\n$$\ny\n$$");
});
it("typesets and native-copies a bare environment with a commented opener", () => {
  const source = "\\begin{align}\n% \\begin{align}\na &= b\n\\end{align}",
    body = mountMessage(source);
  expect(body.querySelectorAll(".bzm-display")).toHaveLength(1);
  expect(body.querySelector(".bzm-invalid")).toBeNull();
  expect(copyThroughComposer(body).text).toBe(source);
});

it("bounds a negative rule's native message depth at the existing 20em size cap", () => {
  const source = String.raw`$\rule[-21em]{1em}{1em}$`,
    paragraph = mountSource(source);
  expect(paragraph.querySelectorAll(".bzm-math")).toHaveLength(1);
  const depths = [
    ...paragraph.querySelectorAll<HTMLElement>(".katex-html .strut"),
  ].map((node) => -(Number.parseFloat(node.style.verticalAlign) || 0));
  expect(Math.max(...depths)).toBe(20);
  expect(copyThroughComposer(paragraph).text).toBe(source);
});

it.each([String.raw`\(x\ \)`, String.raw`$$x\ $$`])(
  "typesets a terminal control space through the real host and preserves its plain copy: %s",
  (source) => {
    const paragraph = mountSource(source);
    expect(paragraph.querySelectorAll(".bzm-math,.bzm-display")).toHaveLength(
      1,
    );
    expect(paragraph.querySelector(".bzm-invalid")).toBeNull();
    expect(
      paragraph.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent,
    ).toBe("x\\ ");
    expect(copyThroughComposer(paragraph).text).toBe(source);
  },
);

it("copies an equation with an unformatted anchor through native HTML/composer without losing TeX escapes", () => {
  const paragraph = mountSource(String.raw`$$
*a\,b* + y
$$`);
  const copiedSource = paragraph.querySelector(".bzm-src");
  expect(copiedSource).not.toBeNull();
  const copied = copyThroughComposer(paragraph);
  console.log("native-copy-review", JSON.stringify(copied));
  expect(
    indexMessage(copied.markdown, { singleDollar: true }).spans.map(
      (span) => span.tex,
    ),
  ).toEqual([String.raw`*a\,b* + y`]);
  expect(required(copiedSource).closest("em,strong,del")).toBeNull();
});

it.each([
  String.raw`||$x_i$||`,
  String.raw`||\(x\)||`,
  String.raw`**||$x$||**`,
  String.raw`||**$x$**||`,
])(
  "preserves whole native host text instead of revealing spoiler math: %s",
  (source) => {
    const paragraph = mountSource(source),
      native = mountSource(source, false);
    expect(
      paragraph.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap,.bzm-src"),
    ).toHaveLength(0);
    expect(paragraph.textContent).toBe(native.textContent);
    // Fallback means the host's own text/HTML behavior, not byte-exact raw TeX.
    expect(copyThroughComposer(paragraph)).toEqual(copyThroughComposer(native));
  },
);

it.each([
  "buzz://channel/general $$\nx+y\n$$",
  "BUZZ://channel/general $$\nx+y\n$$",
])("leaves every native piece readable in a bare-Buzz body: %s", (source) => {
  const paragraph = mountSource(source),
    native = mountSource(source, false);
  expect(
    paragraph.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap,.bzm-src"),
  ).toHaveLength(0);
  expect(paragraph.textContent).toContain("x+y");
  expect(copyThroughComposer(paragraph)).toEqual(copyThroughComposer(native));
});

it.each([
  "$$x[^n]+y$$\n\n[^n]: note",
  "$a[^n]b$\n\n[^n]: note",
  "$x$[^n]\n\n[^n]: $x$",
  "Note[^n].\n\n[^n]: $z$",
])(
  "preserves native footnote references and literal footer math without render/hide pieces: %s",
  (source) => {
    const body = mountMessage(source),
      native = mountMessage(source, false);
    expect(body.querySelector("section[data-footnotes]")).not.toBeNull();
    expect(body.querySelectorAll("sup")).toHaveLength(1);
    expect(
      body.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap,.bzm-src"),
    ).toHaveLength(0);
    expect(body.textContent).toBe(native.textContent);
    expect(copyThroughComposer(body)).toEqual(copyThroughComposer(native));
  },
);

it("still draws separate equations around a footnote while leaving its footer native", () => {
  const source = "$a$[^n] $b$\n\n[^n]: note",
    body = mountMessage(source),
    native = mountMessage(source, false);
  expect(body.querySelectorAll(".bzm-math")).toHaveLength(2);
  expect(body.querySelectorAll("sup")).toHaveLength(1);
  expect(body.querySelector("section[data-footnotes]")?.textContent).toBe(
    native.querySelector("section[data-footnotes]")?.textContent,
  );
  expect(copyThroughComposer(body).text).toBe(copyThroughComposer(native).text);
});

it.each(["nonumber", "notag"])(
  "typesets numbering suppression and preserves its native copy source: %s",
  (command) => {
    const tex =
      String.raw`\begin{align}a&=b` +
      `\\${command}` +
      String.raw`\\c&=d\end{align}`;
    const source = `$$${tex}$$`,
      paragraph = mountSource(source);
    expect(paragraph.querySelectorAll(".bzm-display")).toHaveLength(1);
    expect(paragraph.querySelectorAll(".eqn-num")).toHaveLength(1);
    const copied = copyThroughComposer(paragraph);
    expect(copied.text).toBe(source);
    expect(
      indexMessage(copied.markdown, { singleDollar: true }).drawn.map(
        (span) => span.tex,
      ),
    ).toEqual([tex]);
  },
);

it("typesets and native-copies verbatim private spellings instead of rejecting them", () => {
  const tex = String.raw`\verb|\df@tag| + x`,
    source = `$$${tex}$$`,
    paragraph = mountSource(source);
  expect(paragraph.querySelectorAll(".bzm-display")).toHaveLength(1);
  expect(paragraph.querySelector(".bzm-invalid")).toBeNull();
  const copied = copyThroughComposer(paragraph);
  expect(copied.text).toBe(source);
  expect(
    indexMessage(copied.markdown, { singleDollar: true }).drawn.map(
      (span) => span.tex,
    ),
  ).toEqual([tex]);
});
it("keeps an over-cap alignment readable as an explicit refusal", () => {
  const tex = String.raw`\begin{alignedat}{17}a&=b\end{alignedat}`,
    paragraph = mountSource(`$$${tex}$$`);
  expect(paragraph.querySelector(".bzm-invalid")).not.toBeNull();
  expect(paragraph.querySelector(".bzm-display")).toBeNull();
  expect(paragraph.textContent).toContain(tex);
});

it.each([
  "$x$\n$$\ny\n$$\n$x$",
  String.raw`$$
a \\ b
$$`,
])(
  "copies each physical math line without offset-based separators or decoded escapes: %s",
  (source) => {
    const paragraph = mountSource(source),
      copied = copyThroughComposer(paragraph);
    expect(
      paragraph.querySelectorAll(".bzm-math,.bzm-display").length,
    ).toBeGreaterThan(0);
    expect(copied.text).toBe(source);
    expect(
      indexMessage(copied.markdown, { singleDollar: true }).spans.map(
        (span) => span.tex,
      ),
    ).toEqual(
      indexMessage(source, { singleDollar: true }).spans.map(
        (span) => span.tex,
      ),
    );
  },
);
it("copies adjacent quoted displays with the host BR between them", () => {
  const source = "> $$\n> x\n> $$\n> $$\n> y\n> $$",
    body = mountMessage(source);
  const paragraph = required(body.querySelector("p")),
    copied = copyThroughComposer(paragraph);
  expect(paragraph.querySelectorAll(".bzm-display")).toHaveLength(2);
  expect(copied.text).toBe("$$\nx\n$$\n$$\ny\n$$");
  const quote = copyThroughComposer(required(body.querySelector("blockquote")));
  expect(quote.markdown).toContain("> $$");
  expect(
    indexMessage(quote.markdown, { singleDollar: true }).spans.map(
      (span) => span.tex,
    ),
  ).toEqual(["x", "y"]);
});
it.each(["$$\na&#10;b\n$$"])(
  "preserves native copy when line-source reconstruction is unavailable: %s",
  (source) => {
    const paragraph = mountSource(source),
      native = mountSource(source, false);
    expect(
      paragraph.querySelectorAll(
        ".bzm-math,.bzm-display,.bzm-gap,.bzm-src,.bzm-invalid",
      ),
    ).toHaveLength(0);
    expect(copyThroughComposer(paragraph)).toEqual(copyThroughComposer(native));
  },
);
it.each([
  String.raw`**$x_i$**`,
  String.raw`**$a\,b$**`,
  String.raw`**\(x\)**`,
  String.raw`*\[x\]*`,
  String.raw`~~$x_i$~~`,
  String.raw`*$\frac{a}{b}$*`,
  "*$$\nx+y\n$$*",
])(
  "typesets formatted math with raw selection source and unchanged host-rich-copy behavior: %s",
  (source) => {
    const paragraph = mountSource(source),
      copied = copyThroughComposer(paragraph),
      expected = indexMessage(source, { singleDollar: true });
    expect(paragraph.querySelectorAll(".bzm-math,.bzm-display")).toHaveLength(
      1,
    );
    expect(copied.text).toBe(required(expected.spans[0]).source);
    // Host rich copy normalizes marked Markdown in both builds; this is a
    // non-regression against native copy, not a byte-exact TeX promise.
    expect(copied.markdown).toBe(
      copyThroughComposer(mountSource(source, false)).markdown,
    );
  },
);
it("typesets a marked-only source line rather than vetoing the equation", () => {
  const source = "$$\n*x*\n$$",
    paragraph = mountSource(source);
  expect(paragraph.querySelectorAll(".bzm-display")).toHaveLength(1);
  expect(copyThroughComposer(paragraph).text).toBe(source);
});
it("copies CRLF source with the host's LF breaks", () => {
  const paragraph = mountSource("$$\r\nx+y\r\n$$");
  expect(copyThroughComposer(paragraph).text).toBe("$$\nx+y\n$$");
});

it.each([
  "$$\na\nx\n\\notacommand\n$$\n\n$$\nb\nx\n$$",
  String.raw`$$\notacommand *$$ and $$* b$$`,
  "\\(\nx\n\\tag{1}\n\\)\n\n\\[\nx\n\\tag{1}\n\\]",
  "$$\na\nx\n\\notacommand\n$$\n\n$$\nb\nx\n\\otherbad\n$$",
  "$a*b\\notacommand*c$\n\n\\(a*b\\notacommand*c\\)",
])(
  "keeps all native text/copy when shared hide pieces can have different outcomes: %s",
  (source) => {
    const body = mountMessage(source),
      native = mountMessage(source, false);
    expect(
      body.querySelectorAll(
        ".bzm-math,.bzm-display,.bzm-invalid,.bzm-gap,.bzm-src",
      ),
    ).toHaveLength(0);
    expect(copyThroughComposer(body)).toEqual(copyThroughComposer(native));
  },
);
it("shows every source line with the right title when failed explicit outcomes are equivalent", () => {
  const source =
      "$$\na\nx\n\\notacommand\n$$\n\n$$\nlonger\nx\n\\notacommand\n$$",
    body = mountMessage(source),
    native = mountMessage(source, false);
  const invalid = [...body.querySelectorAll(".bzm-invalid")];
  expect(invalid).toHaveLength(10);
  expect(new Set(invalid.map((piece) => piece.getAttribute("title")))).toEqual(
    new Set(["Undefined control sequence: \\notacommand"]),
  );
  expect(copyThroughComposer(body).text).toBe(copyThroughComposer(native).text);
});
it("exercises the same TeX's differing inline/display outcome through the public renderer", () => {
  expect(draw("x\n\\tag{1}", false).ok).toBe(false);
  expect(draw("x\n\\tag{1}", true).ok).toBe(true);
});
it("checks the exact terminal control-space body rendered by a native code block", async () => {
  const tex = " x\\ ",
    source = `~~~math\n${tex}\n~~~`,
    body = mountMessage(source);
  expect(body.querySelector(".bzm-fence annotation")?.textContent).toBe(tex);
  expect(body.querySelector(".bzm-error")).toBeNull();
  expect(await tool.call(null, null, { markdown: source })).toContain(
    "Summary: 1 spans, 1 render, 0 fail",
  );
});
it("checks the invalid math fence the native GFM footnote actually renders", async () => {
  const tex = "\\fracc{a}",
    source = `See[^n].\n\n[^n]: note\n\n    ~~~math\n    ${tex}\n    ~~~`,
    body = mountMessage(source);
  const footer = required(body.querySelector("section[data-footnotes]"));
  expect(footer).not.toBeNull();
  expect(footer.querySelector(".bzm-source")?.textContent).toBe(tex);
  expect(footer.querySelector(".bzm-error")?.textContent).toContain(
    "Undefined control sequence",
  );
  expect(await tool.call(null, null, { markdown: source })).toContain(
    "Summary: 1 spans, 0 render, 1 fail",
  );
});

it("draws and rich-copies a multiline equation after a host literal punctuation entity", () => {
  const paragraph = mountSource("Contact a&#64;b.com: $$\nx+y\n$$");
  expect(paragraph.querySelectorAll(".bzm-display")).toHaveLength(1);
  expect(paragraph.querySelector(".bzm-src")?.textContent).toBe("$$");
  expect(
    [...paragraph.querySelectorAll(".bzm-src,.bzm-gap")].map(
      (piece) => piece.textContent,
    ),
  ).toEqual(["$$", "x+y", "$$"]);
  const copied = copyThroughComposer(paragraph);
  expect(copied.text).toContain("$$\nx+y\n$$");
  expect(
    indexMessage(copied.markdown, { singleDollar: true }).drawn.map(
      (span) => span.tex,
    ),
  ).toEqual(["x+y"]);
});

it("keeps math next to a spoiler outside its mark and rich-copies it unchanged", () => {
  const source = String.raw`||secret|| then $x_i$`,
    paragraph = mountSource(source);
  const copiedSource = paragraph.querySelector(".bzm-src");
  expect(copiedSource).not.toBeNull();
  expect(required(copiedSource).closest("[data-spoiler]")).toBeNull();
  const copied = copyThroughComposer(paragraph);
  expect(copied.text).toBe(source);
  expect(
    indexMessage(copied.markdown, { singleDollar: true }).drawn.map(
      (span) => span.tex,
    ),
  ).toEqual(["x_i"]);
});

it.each([
  String.raw`$x_i$`,
  String.raw`$a\,b$`,
  String.raw`\(x\)`,
  String.raw`\[x\]`,
])(
  "still typesets unformatted controls and preserves both copy flavors: %s",
  (source) => {
    const paragraph = mountSource(source),
      copied = copyThroughComposer(paragraph);
    expect(paragraph.querySelectorAll(".bzm-math,.bzm-display")).toHaveLength(
      1,
    );
    expect(copied.text).toBe(source);
    const expected = indexMessage(source, { singleDollar: true }).spans.map(
      ({ tex, delimiter }) => ({ tex, delimiter }),
    );
    expect(
      indexMessage(copied.markdown, { singleDollar: true }).spans.map(
        ({ tex, delimiter }) => ({ tex, delimiter }),
      ),
    ).toEqual(expected);
  },
);

it("keeps the full native dollar prose when trust would consume a visible argument", () => {
  const source = String.raw`$a+\href{/docs}{b}+c$`,
    body = mountMessage(source),
    native = mountMessage(source, false);
  expect(
    body.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap,.bzm-invalid"),
  ).toHaveLength(0);
  expect(body.textContent).toBe(native.textContent);
  expect(copyThroughComposer(body)).toEqual(copyThroughComposer(native));
});
it("shows full explicit source as invalid instead of a partial red trusted command", () => {
  const source = String.raw`$$a+\href{/docs}{b}+c$$`,
    body = mountMessage(source);
  expect(body.querySelectorAll(".bzm-math,.bzm-display,.bzm-gap")).toHaveLength(
    0,
  );
  expect(body.querySelector(".bzm-invalid")?.textContent).toBe(source);
  expect(body.querySelector(".bzm-invalid")?.getAttribute("title")).toContain(
    "Links, images and HTML commands",
  );
  expect(copyThroughComposer(body).text).toBe(source);
});
it("keeps the denied fence argument visible in the error/source fallback", () => {
  const tex = String.raw`\href{https://example.com}{x=1}`,
    body = mountMessage(`\`\`\`math\n${tex}\n\`\`\``);
  expect(body.querySelector(".bzm-fence")).toBeNull();
  expect(body.querySelector(".bzm-error")?.textContent).toContain(
    "Links, images and HTML commands",
  );
  expect(body.querySelector(".bzm-source")?.textContent).toBe(tex);
  expect(copyThroughComposer(body).text).toContain(tex);
});
it.each(["<>", "<\u2010"])(
  "mounts the equation beside a spoiler-like authored reference instead of orphan hides: %s",
  (label) => {
    const source = `[ref ${label}]: https://example.test\n\n[ref ||] $$\nx+y\n$$`,
      body = mountMessage(source),
      native = mountMessage(source, false);
    expect(
      body.querySelectorAll(".bzm-display .katex-display"),
      JSON.stringify(
        [...body.querySelectorAll(".bzm-gap")].map((node) => ({
          text: node.textContent,
          hidden: (node as HTMLElement).hidden,
          display: getComputedStyle(node).display,
        })),
      ),
    ).toHaveLength(1);
    expect(body.querySelector("annotation")?.textContent).toBe("x+y");
    expect(copyThroughComposer(body).text).toBe(
      copyThroughComposer(native).text,
    );
  },
);
it("mounts the equation beside a bound profile with an authored old-mask reference label", () => {
  const source =
    "[ref \uFFFC\uE100\uE100\uE100]: https://example.test\n\n[ref @Ana] $$\nx+y\n$$";
  const id = "a".repeat(64),
    profiles = new Map([[id, { name: "Ana" }]]);
  const directory = { ...emptyReferenceDirectory, profiles };
  const bound = createInline(React, engine, NoExpand, () => ({
    profiles: { snapshot: () => profiles },
  }));
  const entries = [
    {
      ...bound,
      key: "math/profile-copy-review",
      pluginId: "math",
      revision: "1",
    },
  ];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const mount = (withMath: boolean) =>
    render(
      <ToastProvider>
        <MessageMarkdown
          directory={directory}
          row={{
            id: "profile-copy-review",
            channelId: "fixture",
            authorId: "fixture-author",
            createdAt: 1,
            content: source,
            mentions: [id],
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          extensions={
            withMath
              ? {
                  inline: registry,
                  codeBlocks,
                  tools: { snapshot: () => empty, subscribe: () => () => {} },
                }
              : undefined
          }
          media={() => undefined}
          onOpenLink={() => false}
        />
      </ToastProvider>,
    ).container;
  const body = mount(true),
    native = mount(false);
  expect(
    body.querySelectorAll(".bzm-display .katex-display"),
    JSON.stringify(
      [...body.querySelectorAll(".bzm-gap")].map((node) => ({
        text: node.textContent,
        hidden: (node as HTMLElement).hidden,
        display: getComputedStyle(node).display,
      })),
    ),
  ).toHaveLength(1);
  expect(body.querySelector("annotation")?.textContent).toBe("x+y");
  expect(copyThroughComposer(body).text).toBe(copyThroughComposer(native).text);
});
it.each([
  "> $$\n> x\n> \\>\n> y\n> $$",
  "> > $$\n> > x\n> > \\>\n> > y\n> > $$",
  "> - $$\n>   x\n>   \\>\n>   y\n>   $$",
])(
  "renders no extra quote operator and native-copies only the authored body: %s",
  (source) => {
    const body = mountMessage(source),
      paragraph = required(body.querySelector<HTMLElement>("p,li"));
    expect(
      paragraph.querySelectorAll(".bzm-display .katex-display"),
    ).toHaveLength(1);
    expect(paragraph.querySelector("annotation")?.textContent).toBe(
      "x\n\\>\ny",
    );
    expect(
      [...paragraph.querySelectorAll(".katex-mathml mo")].some(
        (node) => node.textContent === ">",
      ),
    ).toBe(false);
    expect(copyThroughComposer(paragraph).text).toBe("$$\nx\n\\>\ny\n$$");
    const copied = copyThroughComposer(body);
    expect(
      indexMessage(copied.markdown, { singleDollar: true }).spans.map(
        (span) => span.tex,
      ),
    ).toEqual(["x\n\\>\ny"]);
  },
);

it("keeps a trust-refused URL environment fully native when its percent comments the closer", () => {
  const source = "\\begin{align}\na&=b\n\\url{a%20} \\end{align}",
    body = mountMessage(source),
    native = mountMessage(source, false);
  expect(
    body.querySelectorAll(
      ".bzm-math,.bzm-display,.bzm-gap,.bzm-src,.bzm-invalid",
    ),
  ).toHaveLength(0);
  expect(copyThroughComposer(body)).toEqual(copyThroughComposer(native));
});
