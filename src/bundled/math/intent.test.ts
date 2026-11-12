// @vitest-environment jsdom
// The product's intent, as messages people and agents actually
// write: each must keep typesetting (or, for prices, stay text) through the
// host's real segments. Review fixes narrow behavior one edge case at a time;
// a fix that turns one of these into plain text is a regression to reject,
// not an expectation to update.
import { describe, expect, it } from "vitest";
import { hostSegments } from "./engine/detect";
import { engine } from "./engine/index";
import { PROSE } from "./ui/inline";

const R = String.raw;
const ana = { names: ["Ana"], channels: [] };

/** Equations the reader sees typeset: render pieces, over every segment the
 * host offers, whose TeX draws. */
function typeset(
  message: string,
  references = { names: [] as string[], channels: [] as string[] },
) {
  const index = engine.index(message, { ...PROSE, references });
  return hostSegments(message, references)
    .flatMap((text) => index.pieces(text))
    .filter(
      (piece) =>
        piece.role === "render" &&
        engine.render(piece.span.tex, piece.span.display).ok,
    ).length;
}

describe("what people write keeps typesetting", () => {
  it.each([
    ["inline", R`Euler: $e^{i\pi}+1=0$`, 1],
    ["several inline", R`The ratio is $\frac{a}{b}$, so $a=b$, $c$, $d$.`, 4],
    ["display", "$$\nx^2+y^2=z^2\n$$", 1],
    ["one-line display", R`$$\int_0^1 x\,dx$$`, 1],
    ["two displays with text between", "$$\na\n$$\ntext\n$$\nb\n$$", 2],
    ["two adjacent displays", "$$\na\n$$\n$$\nb\n$$", 2],
    [
      "two displays in their own paragraphs",
      "First:\n\n$$\na\n$$\n\nSecond:\n\n$$\nb\n$$",
      2,
    ],
    ["display, then its symbols inline", "$$\na\n$$\nwhere $a$ is real", 2],
    ["the same inline equation twice", "$x$ then $x$\n\nand again $x$", 3],
    ["inline either side of a display", "$x$\n$$\ny\n$$\n$x$", 3],
    ["paren and bracket delimiters", R`\(x\) and \[y\]`, 2],
    ["multi-line paren", "before \\(a\nb\\) after", 1],
    ["environment", R`\begin{align}a&=b\\c&=d\end{align}`, 1],
    ["matrix", R`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`, 1],
    ["chemistry", R`$\ce{H2O}$`, 1],
    ["subscripts and products", "$a_1 + a_2$ and $a*b*c$", 2],
    ["bold label", "**Answer:** $x=5$", 1],
    ["bold math", "**$x=5$** and *$y$* and ~~$z$~~", 3],
    ["list", "- $x$\n- $y$\n  - $z$", 3],
    ["numbered list", "1. $x$\n2. $y$", 2],
    ["quote", "> $x$ is small", 1],
    ["heading", "## Result $x$", 1],
    ["table", "| a | b |\n|---|---|\n| $x$ | $y$ |", 2],
    [
      "beside a link and code",
      "see [docs](https://example.com) for $x$, not `$y$`",
      1,
    ],
    ["beside a bare link", "see https://example.com for $x$\n$$\ny\n$$", 2],
    ["beside a mention", "@Ana says $x+1$", 1, ana],
  ] as const)("%s", (_, message, expected, references?) => {
    expect(
      typeset(
        message,
        references && { names: [...references.names], channels: [] },
      ),
    ).toBe(expected);
  });

  it("leaves prices as text", () => {
    expect(typeset("It costs $5 and $10 today, or $5.99")).toBe(0);
  });
});
