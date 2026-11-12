// @vitest-environment node
import { expect, it } from "vitest";
import { indexMessage } from "./detect";

it.each([
  {
    name: "channel occurrences",
    source: `${"#a ".repeat(33_000)}$x$`,
    references: { names: [], channels: ["a"] },
  },
  {
    name: "spoiler/profile intersections",
    source: `${"||s|| @b ".repeat(11_000)}$x$`,
    references: { names: ["b"], channels: [] },
  },
])(
  "indexes cap-sized $name without quadratic overlap scans",
  ({ source, references }) => {
    expect(source).toHaveLength(99_003);
    const some = Array.prototype.some,
      budget = 8 * source.length;
    let visits = 0;
    // Count actual overlap-predicate visits, not time under parallel-worker load.
    // These range lists are the growing channel cuts / complete profile cuts.
    Array.prototype.some = function (this: unknown[], predicate, thisArg) {
      const first = this[0] as
        | { start?: unknown; end?: unknown; role?: unknown }
        | undefined;
      if (
        !first ||
        typeof first.start !== "number" ||
        typeof first.end !== "number" ||
        first.role !== undefined
      )
        return some.call(this, predicate, thisArg);
      return some.call(this, (value, index, array) => {
        // Stop a quadratic counterfactual promptly; index catches preparation
        // errors, so assert the work budget before checking the returned index.
        if (++visits > budget)
          throw Error("Range-overlap work budget exceeded");
        return predicate.call(thisArg, value, index, array);
      });
    };
    let result: ReturnType<typeof indexMessage>;
    try {
      result = indexMessage(source, { singleDollar: true, references });
    } finally {
      Array.prototype.some = some;
    }
    expect(visits, "linear range-overlap predicate budget").toBeLessThanOrEqual(
      budget,
    );
    expect(result.drawn.map((span) => span.tex)).toEqual(["x"]);
    expect(result.pieces(" $x$").map((piece) => piece.role)).toEqual([
      "render",
    ]);
  },
);
