// LaTeX command completion, only inside open math in the
// draft (engine.insideMath), so backslashes in prose never trigger it.
import type * as ReactNS from "react";
import type { Engine } from "../contract";
import type { ComposerCompletion } from "./host";
import { createDrawing } from "./drawing";

type CompletionProps = ReactNS.ComponentProps<ComposerCompletion["component"]>;

const LIMIT = 8;

/** The `\name` being typed at the caret, when the engine says it is inside math.
 * Whether text is math is detection (the engine's); this only reads the token. */
export function mathQuery(
  text: string,
  caret: number,
  end: number,
  insideMath: Engine["insideMath"],
) {
  if (
    !Number.isInteger(caret) ||
    caret !== end ||
    caret < 0 ||
    caret > text.length
  )
    return null;
  const before = text.slice(0, caret);
  const match = /\\([a-zA-Z]+)$/.exec(before);
  if (!match) return null;
  // An odd run of backslashes before it means `\\alpha`: a TeX line break, then text.
  let slashes = 0;
  for (let i = match.index - 1; i >= 0 && before[i] === "\\"; i--) slashes++;
  if (slashes % 2) return null;
  if (!insideMath(before)) return null;
  return { start: match.index, end: caret, query: match[0] };
}

export function createCompletion(
  React: typeof ReactNS,
  engine: Engine,
): ComposerCompletion {
  const Drawing = createDrawing(React);

  function Preview({ tex }: { tex: string }) {
    const outcome = React.useMemo(() => engine.render(tex, false), [tex]);
    return outcome.ok ? (
      <Drawing className="bzm-suggestion" element={outcome.element} />
    ) : null;
  }

  function LatexCompletion({ query, publish }: CompletionProps) {
    React.useEffect(() => {
      const items = engine.commands(query.query, LIMIT).map((command) => ({
        id: command.name,
        label: command.name,
        detail: command.detail,
        preview: <Preview tex={command.preview} />,
        edit: { text: command.insert },
      }));
      const withdraw = publish({ items });
      return withdraw || undefined;
    }, [query.query, publish]);
    return null;
  }

  return {
    id: "latex",
    title: "LaTeX commands",
    match: (observation) =>
      mathQuery(
        observation.text,
        observation.start,
        observation.end,
        engine.insideMath,
      ),
    component: LatexCompletion,
  };
}
