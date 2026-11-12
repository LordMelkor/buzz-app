// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFence } from "./codeblock";
import { createCompletion, mathQuery } from "./completion";
import {
  applyTemplate,
  createEquationTool,
  equationText,
  TEMPLATES,
} from "./composer";
import { fakeEngine, fakeIndex, fakeRender, span } from "./fakeEngine";
import { createIcons } from "./icons";
import { createExpand } from "./expand";
import { createInline, PROSE, trackSelection } from "./inline";
import "./jsdomDialog";
import { engine as realEngine } from "../engine";
import { hostSegments } from "../engine/detect";
import { required } from "../required";
import { installStyles } from "./styles";

afterEach(cleanup);
const icons = createIcons(React);
const message = (content: string) => ({ content, mentions: [] }) as never;

describe("fence (C2)", () => {
  const copy = vi.fn(async () => true);
  const fence = createFence(
    React,
    fakeEngine(),
    createExpand(React, fakeEngine(), icons, copy),
  );
  const Fence = fence.component;
  const Expand = required(fence.action);

  // Which languages are math is the engine's (render.test "classifies fence").
  it("claims exactly the languages the engine classifies as math", () => {
    const only = createFence(
      React,
      fakeEngine({
        fenceMode: (language) => (language === "tex" ? "latex" : null),
      }),
      fence.action as never,
    );
    expect(["tex", "math"].map(only.matches)).toEqual([true, false]);
  });

  it("offers no Expand where its dialog couldn't be dismissed", () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    // A WebView without modal dialogs.
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
      .showModal;
    try {
      const Unsupported = createExpand(React, fakeEngine(), icons, copy);
      expect(
        render(<Unsupported tex="x^2" />).container.querySelector("button"),
      ).toBeNull();
    } finally {
      HTMLDialogElement.prototype.showModal = showModal;
    }
  });

  it("draws the equation centered in its own block", () => {
    const { container } = render(<Fence code="x^2" language="math" />);
    expect(
      container.querySelector(".bzm-fence .katex-display [data-tex='x^2']"),
    ).not.toBeNull();
  });

  it("shows the error above the source for a bad math fence", () => {
    render(<Fence code={"\\bad{x}"} language="math" />);
    expect(screen.getByRole("note").textContent).toBe(
      "Undefined control sequence: \\bad",
    );
    expect(screen.getByText("\\bad{x}").className).toBe("bzm-source");
  });

  it("throws for a latex fence that is not math, so the host shows the code", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(<Fence code={"\\bad\\documentclass{article}"} language="latex" />),
    ).toThrow();
    vi.restoreAllMocks();
  });

  it("stays open under React's development double effect", () => {
    render(
      <React.StrictMode>
        <Expand code="a+b" language="math" />
      </React.StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand equation" }));
    expect(
      (document.querySelector("dialog.bzm-dialog") as HTMLDialogElement | null)
        ?.open,
    ).toBe(true);
  });

  it("offers no Expand for a fence that does not render", () => {
    const { container } = render(<Expand code={"\\bad"} language="math" />);
    expect(container.innerHTML).toBe("");
  });

  it("drops an open dialog when the fence stops rendering, and never reopens it", () => {
    const { rerender } = render(<Expand code="a+b" language="math" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand equation" }));
    rerender(<Expand code={"\\bad"} language="math" />);
    expect(document.querySelector("dialog.bzm-dialog")).toBeNull();
    rerender(<Expand code="a+b" language="math" />);
    expect(document.querySelector("dialog.bzm-dialog")).toBeNull();
  });

  it("keeps the dialog's events from the message row, and a link from following", () => {
    const row = {
      mousedown: vi.fn(),
      contextmenu: vi.fn(),
      dblclick: vi.fn(),
      copy: vi.fn(),
      keydown: vi.fn(),
      click: vi.fn(),
    };
    render(
      // biome-ignore lint/a11y/useValidAnchor: The test models a host row that is a real link; its handlers must see Expand's events.
      <a
        href="#elsewhere"
        onClick={row.click}
        onMouseDown={row.mousedown}
        onContextMenu={row.contextmenu}
        onDoubleClick={row.dblclick}
        onCopy={row.copy}
        onKeyDown={row.keydown}
      >
        <Expand code="a+b" language="math" />
      </a>,
    );
    const expand = screen.getByRole("button", { name: "Expand equation" });
    expect(fireEvent.click(expand)).toBe(false); // default prevented: the link stays put
    const source = required(document.querySelector(".bzm-dialog-source"));
    fireEvent.mouseDown(source);
    fireEvent.contextMenu(source);
    fireEvent.doubleClick(source);
    fireEvent.copy(source);
    fireEvent.keyDown(source, { key: "Enter" });
    fireEvent.click(source);
    for (const handler of Object.values(row))
      expect(handler).not.toHaveBeenCalled();
  });

  it("expands into a dialog that copies LaTeX and MathML and returns focus", async () => {
    render(<Expand code="a+b" language="math" />);
    const expand = screen.getByRole("button", { name: "Expand equation" });
    fireEvent.click(expand);
    const dialog = document.querySelector(
      "dialog.bzm-dialog",
    ) as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    expect(
      dialog.querySelector(".bzm-dialog-equation [data-tex='a+b']"),
    ).not.toBeNull();
    expect(dialog.querySelector(".bzm-dialog-source")?.textContent).toBe("a+b");

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy LaTeX" })),
    );
    expect(copy).toHaveBeenLastCalledWith("a+b");
    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy MathML" })),
    );
    expect(copy).toHaveBeenLastCalledWith(
      '<math><annotation encoding="application/x-tex">a+b</annotation></math>',
    );

    act(() =>
      fireEvent.click(
        required(screen.getAllByRole("button", { name: "Close" })[0]),
      ),
    );
    expect(document.querySelector("dialog.bzm-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });
});

describe("prose (C3)", () => {
  const copy = vi.fn(async () => true);
  const inline = (table: Parameters<typeof fakeIndex>[0]) => {
    const engine = fakeEngine({ index: () => fakeIndex(table) });
    return createInline(
      React,
      engine,
      createExpand(React, engine, icons, copy),
      () => undefined,
    );
  };
  const show = (
    renderer: ReturnType<typeof inline>,
    segment: string,
    text: string,
  ) => {
    const Component = renderer.component;
    // The fake index ignores the body, which only needs a math delimiter.
    const content = { text: segment, message: message("$…$") };
    return render(
      <p>
        <Component
          text={text}
          content={content}
          media={() => undefined}
          canOpen={() => false}
          open={() => false}
        />
      </p>,
    );
  };

  it("claims the math in a host segment, read against the whole message", () => {
    const renderer = createInline(
      React,
      realEngine,
      createExpand(React, realEngine, icons, copy),
      () => undefined,
    );
    // The host passes each line alone; only the whole message says `x^2` is display math.
    const body = "costs $5 and $10\n$$\nx^2\n$$\nthe energy $E=mc^2$ is";
    const at = (text: string) =>
      renderer.matches({ text, message: message(body) });
    expect(at("x^2")).toEqual([{ start: 0, end: 3 }]);
    expect(at("the energy $E=mc^2$ is")).toEqual([{ start: 11, end: 19 }]);
    expect(at("costs $5 and $10")).toEqual([]);
  });

  // The host's bundled custom-emoji renderer runs first and wins overlapping
  // ranges, so an equation over one of the message's shortcodes must leave
  // every line as text, not hide the lines it can't draw (review pass 4 #3).
  it("leaves an equation over one of the message's custom emoji as text", () => {
    const renderer = createInline(
      React,
      realEngine,
      createExpand(React, realEngine, icons, copy),
      () => undefined,
    );
    const body = {
      content: "$$\\text{:party:}\nx+y\n$$",
      mentions: [],
      emoji: [{ shortcode: "party", url: "https://example.com/p.png" }],
    } as never;
    for (const text of ["$$\\text{:party:}", "x+y", "$$"])
      expect(renderer.matches({ text, message: body })).toEqual([]);
  });

  // The host also offers each reaction chip's text, with the message it
  // reacts to. That text isn't part of the body, so no equation maps into it.
  it("leaves a reaction's text as written", () => {
    const renderer = createInline(
      React,
      realEngine,
      createExpand(React, realEngine, icons, copy),
      () => undefined,
    );
    const body = { content: "$x$", mentions: [] } as never;
    expect(renderer.matches({ text: "$x$", message: body })).toEqual([
      { start: 0, end: 3 },
    ]);
    expect(
      renderer.matches({
        text: "$x$",
        message: body,
        reaction: { content: "$x$" },
      } as never),
    ).toEqual([]);
  });

  // The host offers every segment of a message on its own; the message's
  // reference context must not be rebuilt for each one (review pass 4 #4).
  it("reads a long message against a large channel directory without stalling the row", () => {
    // Like the host's, the list is an immutable snapshot until it changes.
    const list = {
      channels: Array.from({ length: 2_000 }, (_, i) => ({
        id: `c${i}`,
        name: `channel-${i}`,
      })),
    };
    const directory = { channels: { list: () => list } };
    const renderer = createInline(
      React,
      realEngine,
      createExpand(React, realEngine, icons, copy),
      () => directory,
    );
    const lines = Array.from(
      { length: 400 },
      (_, i) => `item #${i} is $x_{${i}}$`,
    );
    const body = message(lines.join("\n"));
    const start = performance.now();
    for (const text of lines)
      expect(renderer.matches({ text, message: body })).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  // The host asks once per segment. After the first segment's read, the
  // others cost the same however long the message is.
  it.each([
    ["no math", "word ".repeat(400_000)],
    ["its only math at the end", `${"word ".repeat(19_990)}$x$`],
  ])(
    "reads a long message with %s in time independent of its segment count",
    (_label, content) => {
      const renderer = createInline(
        React,
        realEngine,
        createExpand(React, realEngine, icons, copy),
        () => undefined,
      );
      const body = message(content);
      expect(renderer.matches({ text: "word", message: body })).toEqual([]);
      let matched = 0;
      const start = performance.now();
      for (let i = 0; i < 20_000; i++)
        matched += renderer.matches({ text: "word", message: body }).length;
      expect(performance.now() - start).toBeLessThan(50);
      expect(matched).toBe(0);
    },
  );

  it("draws inline math with its hidden source for selection copy", () => {
    const energy = span("$E=mc^2$", "E=mc^2");
    const { container } = show(
      inline({
        "is $E=mc^2$": [
          {
            start: 3,
            end: 11,
            role: "render",
            joinBefore: false,
            joinAfter: false,
            span: energy,
            source: "$E=mc^2$",
          },
        ],
      }),
      "is $E=mc^2$",
      "$E=mc^2$",
    );
    const math = required(container.querySelector(".bzm-math"));
    expect(math.querySelector(".bzm-draw .katex")?.textContent).toBe("E=mc^2");
    const source = required(math.querySelector(".bzm-src"));
    expect(source.textContent).toBe("$E=mc^2$");
    expect(source.getAttribute("aria-hidden")).toBe("true");
  });

  // Each line copies its own source; the host's breaks between them copy too.
  it("draws display math as a block and hides the other lines of the span, each keeping its source", () => {
    const block = span("$$\na \\\\ b\n$$", "a \\\\ b", true);
    const renderer = inline({
      $$: [
        {
          start: 0,
          end: 2,
          role: "hide",
          joinBefore: false,
          joinAfter: false,
          span: block,
          source: "$$",
        },
      ],
      // Markdown drops an escaping backslash from the host's text.
      "a \\ b": [
        {
          start: 0,
          end: 5,
          role: "render",
          joinBefore: false,
          joinAfter: false,
          span: block,
          source: "a \\\\ b",
        },
      ],
    });
    const drawn = required(
      show(renderer, "a \\ b", "a \\ b").container.querySelector(
        ".bzm-display",
      ),
    );
    expect(drawn.querySelector(".katex-display")).not.toBeNull();
    expect(drawn.querySelector(".bzm-src")?.textContent).toBe("a \\\\ b");
    cleanup();
    const gap = show(renderer, "$$", "$$").container.querySelector(
      ".bzm-gap",
    ) as HTMLElement;
    expect(gap.hidden).toBe(true);
    expect(gap.textContent).toBe("$$");
  });

  it("gives display math the Expand action, with its TeX, but not inline math", () => {
    const block = span("$$x^2$$", "x^2", true);
    const { container } = show(
      inline({
        "$$x^2$$": [
          {
            start: 0,
            end: 7,
            role: "render",
            joinBefore: false,
            joinAfter: false,
            span: block,
            source: "$$x^2$$",
          },
        ],
      }),
      "$$x^2$$",
      "$$x^2$$",
    );
    const expand = required(
      container.querySelector(".bzm-display > .bzm-display-actions button"),
    );
    expect(expand.getAttribute("aria-label")).toBe("Expand equation");
    act(() => fireEvent.click(expand));
    expect(
      document.querySelector("dialog.bzm-dialog .bzm-dialog-source")
        ?.textContent,
    ).toBe("x^2");
    cleanup();
    const energy = span("$E$", "E");
    const plain = show(
      inline({
        $E$: [
          {
            start: 0,
            end: 3,
            role: "render",
            joinBefore: false,
            joinAfter: false,
            span: energy,
            source: "$E$",
          },
        ],
      }),
      "$E$",
      "$E$",
    );
    expect(plain.container.querySelector("button")).toBeNull();
  });

  it("leaves a $…$ that fails to parse as plain text", () => {
    const money = span("$\\bad$", "\\bad");
    const { container } = show(
      inline({
        "$\\bad$": [
          {
            start: 0,
            end: 6,
            role: "render",
            joinBefore: false,
            joinAfter: false,
            span: money,
            source: "$\\bad$",
          },
        ],
      }),
      "$\\bad$",
      "$\\bad$",
    );
    expect(container.innerHTML).toBe("<p>$\\bad$</p>");
  });

  it("shows every part of a failed $…$ that Markdown split, as the host would", () => {
    const split = span("$a*b\\bad*c$", "a*b\\bad*c");
    const renderer = inline({
      $a: [
        {
          start: 0,
          end: 2,
          role: "render",
          joinBefore: false,
          joinAfter: false,
          span: split,
          source: "$a*b\\bad*c$",
        },
      ],
      "b\\bad": [
        {
          start: 0,
          end: 5,
          role: "hide",
          joinBefore: false,
          joinAfter: false,
          span: split,
          source: "",
        },
      ],
      c$: [
        {
          start: 0,
          end: 2,
          role: "hide",
          joinBefore: false,
          joinAfter: false,
          span: split,
          source: "",
        },
      ],
    });
    for (const text of ["$a", "b\\bad", "c$"]) {
      expect(show(renderer, text, text).container.innerHTML).toBe(
        `<p>${text}</p>`,
      );
      cleanup();
    }
  });

  // The engine clones a drawing per call, so a long display's hidden lines
  // must not each hold a copy of it (review pass 12).
  it("draws a long display once, however many lines it hides", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `x_{${i}}`);
    const block = span(`$$\n${lines.join("\n")}\n$$`, lines.join("\n"), true);
    const role = (i: number) => (i ? ("hide" as const) : ("render" as const));
    const draws = vi.fn(fakeRender);
    const engine = fakeEngine({
      index: () =>
        fakeIndex(
          Object.fromEntries(
            lines.map((line, i) => [
              line,
              [
                {
                  start: 0,
                  end: line.length,
                  role: role(i),
                  span: block,
                  source: line,
                  joinBefore: false,
                  joinAfter: false,
                },
              ],
            ]),
          ),
        ),
      render: draws,
    });
    const renderer = createInline(
      React,
      engine,
      createExpand(React, engine, icons, copy),
      () => undefined,
    );
    for (const line of lines) show(renderer, line, line);
    expect(
      document.querySelectorAll(".bzm-display .katex-display"),
    ).toHaveLength(1);
    expect(document.querySelectorAll(".bzm-gap[hidden]")).toHaveLength(49);
    expect(draws.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // Each line of a failed equation shows its own source as written.
  it("marks every line of a failed $$…$$ with its error instead of hiding it", () => {
    const meant = span("$$\n\\bad\n$$", "\\bad", true);
    const renderer = inline({
      $$: [
        {
          start: 0,
          end: 2,
          role: "hide",
          joinBefore: false,
          joinAfter: false,
          span: meant,
          source: "$$",
        },
      ],
      "\\bad": [
        {
          start: 0,
          end: 4,
          role: "render",
          joinBefore: false,
          joinAfter: false,
          span: meant,
          source: "\\bad",
        },
      ],
    });
    for (const line of ["$$", "\\bad"]) {
      const { container } = show(renderer, line, line);
      expect(container.querySelector(".bzm-gap")).toBeNull();
      const invalid = required(container.querySelector(".bzm-invalid"));
      expect(invalid.textContent).toBe(line);
      expect(invalid.getAttribute("title")).toBe(
        "Undefined control sequence: \\bad",
      );
      cleanup();
    }
  });

  // The host joins a paragraph's lines with <br>s; the stylesheet hides those
  // inside an equation, never the prose's own (review pass 10).
  it.each([
    ["Start \\(a\n+b\\)\nFinish", "Start [math]\nFinish"],
    ["Start \\(a\n+b\n+c\\) end\nFinish", "Start [math] end\nFinish"],
    ["Before\n$$\na\nb\n$$\nafter", "Before[display]after"],
    // Sibling selectors skip text, so prose beside a display must not lose its break (review pass 11).
    ["$$x$$ tail\nnext", "[display] tail\nnext"],
    ["first\nbefore $$x$$", "first\nbefore [display]"],
    ["$$\na\n$$ tail\nnext", "[display] tail\nnext"],
    // A span's render anchor may be a later line; that line's break is still the span's (review pass 12).
    [
      "Before \\(a\n+b\\) one\nBefore \\(a\n+c\\) two",
      "Before [math] one\nBefore [math] two",
    ],
  ])(
    "keeps the line breaks around %j that aren't inside its math",
    (content, lines) => {
      const renderer = createInline(
        React,
        realEngine,
        createExpand(React, realEngine, icons, copy),
        () => undefined,
      );
      const Component = renderer.component;
      const body = message(content);
      const host = hostSegments(content, { names: [], channels: [] }).flatMap(
        (segment, line) => {
          let at = 0;
          const nodes: React.ReactNode[] = line
            ? // biome-ignore lint/suspicious/noArrayIndexKey: A segment's position is its identity; the text repeats.
              [<br key={`br${line}`} />]
            : [];
          for (const { start, end } of [
            ...renderer.matches({ text: segment, message: body }),
            { start: segment.length, end: segment.length },
          ]) {
            nodes.push(segment.slice(at, start));
            if (start < end)
              nodes.push(
                <Component
                  // biome-ignore lint/suspicious/noArrayIndexKey: A segment's position is its identity; the text repeats.
                  key={`${line}:${start}`}
                  text={segment.slice(start, end)}
                  content={{ text: segment, message: body }}
                  media={() => undefined}
                  canOpen={() => false}
                  open={() => false}
                />,
              );
            at = end;
          }
          return nodes;
        },
      );
      const stop = installStyles();
      const paragraph = required(
        render(<p>{host}</p>).container.firstElementChild,
      );
      // What a reader sees: math drawn, hidden parts and hidden breaks gone.
      const seen = [...paragraph.childNodes].map((node) => {
        if (!(node instanceof Element)) return node.textContent;
        if (node.matches(".bzm-math, .bzm-display"))
          return node.matches(".bzm-math") ? "[math]" : "[display]";
        return getComputedStyle(node).display === "none" ||
          (node as HTMLElement).hidden
          ? ""
          : "\n";
      });
      stop();
      expect(seen.join("")).toBe(lines);
    },
  );

  it("tints math whose source is inside the selection", () => {
    document.body.innerHTML = `<p id="p">a <span class="bzm-math"><span class="bzm-draw"></span><span class="bzm-src">$x$</span></span> b</p>`;
    const stop = trackSelection();
    const range = document.createRange();
    range.selectNodeContents(required(document.getElementById("p")));
    required(document.getSelection()).removeAllRanges();
    required(document.getSelection()).addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(
      required(document.querySelector(".bzm-math")).hasAttribute(
        "data-selected",
      ),
    ).toBe(true);
    required(document.getSelection()).removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(
      required(document.querySelector(".bzm-math")).hasAttribute(
        "data-selected",
      ),
    ).toBe(false);
    stop();
    document.body.innerHTML = "";
  });
});

describe("composer Equation tool (C4)", () => {
  it("writes inline and display math the detector reads back, whatever the draft holds around it", () => {
    const cases: [string, boolean][] = [
      ["x^2", false],
      ["  x^2 ", false],
      ["\\text{$5}", false],
      ["a\n+b", false],
      ["\\int_0^1 f", true],
    ];
    for (const [tex, display] of cases) {
      // Text before the caret, and a digit after it: `$x$2` would read as a price.
      const spans = realEngine.index(
        `see ${equationText(tex, display)}2`,
        PROSE,
      ).spans;
      expect(spans.map((found) => [found.tex.trim(), found.display])).toEqual([
        [tex.trim(), display],
      ]);
    }
    // A blank line would end the paragraph and the math; KaTeX draws one line break the same.
    expect(equationText("a\n\n  \nb", false)).toBe("\\(a\nb\\)");
    expect(equationText("a\n\nb", true)).toBe("\n$$\na\nb\n$$\n");
  });

  it.each(["Inline", "Display"])(
    "previews and inserts terminal control spaces in %s math",
    (layout) => {
      const inserted: string[] = [],
        tool = createEquationTool(React, realEngine, icons, () => undefined);
      const Tool = tool.component as React.ComponentType<
        Record<string, unknown>
      >;
      render(
        <Tool
          {...{
            disabled: false,
            insertText: (text: string) => {
              inserted.push(text);
              return true;
            },
            focus: () => {},
          }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Equation" }));
      fireEvent.click(screen.getByRole("button", { name: layout }));
      fireEvent.change(screen.getByLabelText("LaTeX"), {
        target: { value: " x\\   " },
      });
      expect(
        document.querySelector(
          '.bzm-preview annotation[encoding="application/x-tex"]',
        )?.textContent,
      ).toBe("x\\ ");
      expect(
        (screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Insert" }));
      const result = realEngine.index(required(inserted[0]), PROSE);
      expect(result.drawn).toHaveLength(1);
      expect(result.spans[0]?.tex).toBe("x\\ ");
      expect(
        realEngine.render(required(result.spans[0]).tex, layout === "Display")
          .ok,
      ).toBe(true);
    },
  );

  // Insert must agree with what a sent message shows. Markdown decodes `\,`
  // to `,`, repeated display lines map nowhere, and the message's prose cuts
  // at `@` names it can't bind and at channel links.
  it("offers Insert for exactly the equations a message shows", () => {
    const general = { id: "c1", name: "general" };
    const palette = {
      entries: [{ shortcode: "party", url: "https://example.com/p.png" }],
    };
    const directory = {
      channels: { list: () => ({ channels: [general] }) },
      emoji: { snapshot: () => palette },
    };
    const tool = createEquationTool(React, realEngine, icons, () => directory);
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    render(
      <Tool
        {...{ disabled: false, insertText: () => true, focus: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    const insert = screen.getByRole("button", {
      name: "Insert",
    }) as HTMLButtonElement;
    const cases: [layout: "Inline" | "Display", tex: string, shown: boolean][] =
      [
        ["Inline", String.raw`\int_{a}^{b} f(x)\,dx`, true],
        ["Inline", String.raw`\text{@home}`, false],
        ["Inline", String.raw`\text{\#general}`, false],
        ["Display", "x\ny", true],
        ["Display", "x\nx", false],
        ["Display", `${String.raw`a\,b \\`}\n${String.raw`\{c\}`}`, true],
        // Sending tags the community emoji a draft uses.
        ["Inline", String.raw`\text{:party:}`, false],
        ["Inline", String.raw`\text{:other:}`, true],
      ];
    for (const [layout, tex, shown] of cases) {
      fireEvent.click(screen.getByRole("button", { name: layout }));
      fireEvent.change(screen.getByLabelText("LaTeX"), {
        target: { value: tex },
      });
      expect([layout, tex, !insert.disabled]).toEqual([layout, tex, shown]);
    }
  });

  // The directory fills while the editor is open: Insert checks what the
  // message will read at the moment it inserts, not what it read at typing.
  it("checks the names a message binds when it inserts, not when the TeX was typed", () => {
    const channels: { id: string; name: string }[] = [];
    const directory = { channels: { list: () => ({ channels }) } };
    const inserted: string[] = [];
    const tool = createEquationTool(React, realEngine, icons, () => directory);
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    render(
      <Tool
        {...{
          disabled: false,
          insertText: (text: string) => {
            inserted.push(text);
            return true;
          },
          focus: () => {},
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: String.raw`\text{\#lab}` },
    });
    expect(
      (screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    channels.push({ id: "c1", name: "lab" });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(inserted).toEqual([]);
    expect(
      screen.getByText("A message can't show this as one equation"),
    ).toBeDefined();
  });

  it("refuses an equation the message would not show, and says why", () => {
    const tool = createEquationTool(
      React,
      fakeEngine({ index: () => fakeIndex({}) }),
      icons,
      () => undefined,
    );
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    render(
      <Tool
        {...{ disabled: false, insertText: () => true, focus: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: "x" },
    });
    expect(
      (screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("A message can't show this as one equation"),
    ).toBeDefined();
    expect(screen.getByLabelText("LaTeX").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("inserts the typed equation and refocuses the composer", () => {
    const tool = createEquationTool(
      React,
      fakeEngine(),
      icons,
      () => undefined,
    );
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    const insertText = vi.fn(() => true);
    const focus = vi.fn();
    render(<Tool {...{ disabled: false, insertText, focus }} />);
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    const insert = screen.getByRole("button", {
      name: "Insert",
    }) as HTMLButtonElement;
    expect(insert.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: "\\bad" },
    });
    expect(insert.disabled).toBe(true);
    expect(screen.getByText("Undefined control sequence: \\bad")).toBeDefined();
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: "a^2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(insert);
    expect(insertText).toHaveBeenCalledWith("\n$$\na^2\n$$\n");
    expect(focus).toHaveBeenCalled();
  });

  it("inserts with ⌘↩ and is unavailable while the composer is disabled", () => {
    const tool = createEquationTool(
      React,
      fakeEngine(),
      icons,
      () => undefined,
    );
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    const insertText = vi.fn(() => true);
    const { rerender } = render(
      <Tool {...{ disabled: false, insertText, focus: () => {} }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: "y" },
    });
    fireEvent.keyDown(screen.getByLabelText("LaTeX"), {
      key: "Enter",
      metaKey: true,
    });
    expect(insertText).toHaveBeenCalledWith("$y$ ");
    const popover = required(
      document.querySelector<HTMLElement>(".bzm-popover"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    expect(popover.style.display).toBe("grid");
    rerender(<Tool {...{ disabled: true, insertText, focus: () => {} }} />);
    expect(
      (screen.getByRole("button", { name: "Equation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(popover.style.display).toBe("none");
  });

  it("opens, cancels and reopens with the draft kept", () => {
    const tool = createEquationTool(
      React,
      fakeEngine(),
      icons,
      () => undefined,
    );
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    render(
      <Tool
        {...{ disabled: false, insertText: () => true, focus: () => {} }}
      />,
    );
    const sigma = screen.getByRole("button", { name: "Equation" });
    fireEvent.click(sigma);
    expect(sigma.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("LaTeX"));
    fireEvent.change(screen.getByLabelText("LaTeX"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sigma.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(sigma);
    fireEvent.click(sigma);
    expect((screen.getByLabelText("LaTeX") as HTMLTextAreaElement).value).toBe(
      "x",
    );
    fireEvent.keyDown(screen.getByLabelText("LaTeX"), { key: "Escape" });
    expect(sigma.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Equation tool templates (U2)", () => {
  const named = (name: string) =>
    required(TEMPLATES.find((template) => template.name === name));

  it("inserts at the caret and selects the placeholder to type over", () => {
    expect(applyTemplate("x+", 2, 2, named("Fraction"))).toEqual({
      value: "x+\\frac{a}{b}",
      selection: [8, 9],
    });
    expect(applyTemplate("x", 1, 1, named("Superscript"))).toEqual({
      value: "x^{n}",
      selection: [3, 4],
    });
  });

  it("wraps a selection in the slot, then selects the next placeholder", () => {
    // "a+b" becomes the numerator; the denominator is next.
    expect(applyTemplate("a+b", 0, 3, named("Fraction"))).toEqual({
      value: "\\frac{a+b}{b}",
      selection: [11, 12],
    });
    // The root's index comes before its radicand and keeps its place.
    expect(applyTemplate("y", 0, 1, named("Root"))).toEqual({
      value: "\\sqrt[n]{y}",
      selection: [6, 7],
    });
    // No next placeholder: the caret follows the insertion.
    expect(applyTemplate("q a+b", 2, 5, named("Superscript"))).toEqual({
      value: "q ^{a+b}",
      selection: [8, 8],
    });
  });

  it("selects each template's own placeholder, never part of a command", () => {
    for (const template of TEMPLATES) {
      const { value, selection } = applyTemplate("", 0, 0, template);
      expect(value.slice(...selection)).toBe(template.slot);
      if (!template.next) continue;
      const filled = applyTemplate("z", 0, 1, template);
      expect(filled.value.slice(...filled.selection)).toBe(template.next);
    }
  });

  it("fills the field from a template button and switches a matrix to Display", () => {
    const tool = createEquationTool(
      React,
      fakeEngine(),
      icons,
      () => undefined,
    );
    const Tool = tool.component as React.ComponentType<Record<string, unknown>>;
    render(
      <Tool
        {...{ disabled: false, insertText: () => true, focus: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Equation" }));
    const field = screen.getByLabelText("LaTeX") as HTMLTextAreaElement;
    expect(
      required(
        screen.getAllByRole("group", { name: "Templates" })[0],
      ).querySelectorAll("button"),
    ).toHaveLength(TEMPLATES.length);
    fireEvent.click(screen.getByRole("button", { name: "Fraction" }));
    expect(field.value).toBe("\\frac{a}{b}");
    expect([field.selectionStart, field.selectionEnd]).toEqual([6, 7]);
    expect(document.activeElement).toBe(field);
    expect(
      screen
        .getByRole("button", { name: "Inline" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Matrix" }));
    expect(field.value).toBe(named("Matrix").tex);
    expect(
      screen
        .getByRole("button", { name: "Display" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("LaTeX completion (C5)", () => {
  // Whether the caret is inside math is the engine's detection (detect.test.ts);
  // the UI only reads the command token and asks.
  it("asks the engine about the draft before the caret and queries the command", () => {
    const insideMath = vi.fn(() => true);
    expect(mathQuery("$x+\\fr tail", 6, 6, insideMath)).toEqual({
      start: 3,
      end: 6,
      query: "\\fr",
    });
    expect(insideMath).toHaveBeenLastCalledWith("$x+\\fr");
    expect(mathQuery("$x+\\fr", 6, 6, () => false)).toBeNull();
  });

  it("ignores selections, plain words and \\\\ line breaks", () => {
    const yes = () => true;
    expect(mathQuery("$x+\\fr", 6, 5, yes)).toBeNull();
    expect(mathQuery("$x+fr", 5, 5, yes)).toBeNull();
    expect(mathQuery("$a \\\\alp", 8, 8, yes)).toBeNull();
    expect(mathQuery("$a \\\\\\alp", 9, 9, yes)).toEqual({
      start: 5,
      end: 9,
      query: "\\alp",
    });
  });

  it("publishes up to eight commands with rendered previews", () => {
    const engine = fakeEngine();
    const commands = vi.spyOn(engine, "commands");
    const completion = createCompletion(React, engine);
    const Component = completion.component as React.ComponentType<
      Record<string, unknown>
    >;
    const withdraw = vi.fn();
    const publish = vi.fn((_result: unknown) => withdraw);
    const { unmount } = render(
      <Component {...{ query: { start: 1, end: 3, query: "\\a" }, publish }} />,
    );
    expect(commands).toHaveBeenCalledWith("\\a", 8);
    const result = required(publish.mock.calls[0])[0] as {
      items: { label: string; edit: unknown; preview: React.ReactNode }[];
    };
    expect(result.items.map((item) => [item.label, item.edit])).toEqual([
      ["\\alpha", { text: "\\alpha" }],
      ["\\aleph", { text: "\\aleph" }],
    ]);
    const { container } = render(required(result.items[0]).preview);
    expect(
      container.querySelector(".bzm-suggestion [data-tex='\\\\alpha']"),
    ).not.toBeNull();
    unmount();
    expect(withdraw).toHaveBeenCalledOnce();
  });
});
