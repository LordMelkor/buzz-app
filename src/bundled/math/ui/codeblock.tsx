// fenced `math`/`katex`/`latex`/`tex` blocks with an Expand
// action (expand.tsx). Self-contained: no message context and no message-row CSS.
import type * as ReactNS from "react";
import type { CodeBlockRenderer } from "./host";
import type { Engine } from "../contract";
import { createDrawing } from "./drawing";
import type { Expand } from "./expand";

/** Thrown for a `latex`/`tex` fence that is not math: the host's boundary shows the code. */
export class NotMath extends Error {}

export function createFence(
  React: typeof ReactNS,
  engine: Engine,
  Expand: Expand,
): CodeBlockRenderer {
  const Drawing = createDrawing(React);

  function Fence({ code, language }: { code: string; language: string }) {
    const outcome = React.useMemo(() => engine.render(code, true), [code]);
    if (outcome.ok)
      return <Drawing className="bzm-fence" element={outcome.element} />;
    if (engine.fenceMode(language) === "latex")
      throw new NotMath(outcome.message);
    return (
      <>
        {/* Not <pre>: the host frame already surrounds this content. */}
        <div className="bzm-error" role="note">
          {outcome.message}
        </div>
        <div className="bzm-source">{code}</div>
      </>
    );
  }

  /** Expand only for a fence that renders; the same call as Fence, so one memo entry. */
  function FenceExpand({ code }: { code: string }) {
    const ok = React.useMemo(() => engine.render(code, true).ok, [code]);
    return ok ? <Expand tex={code} /> : null;
  }

  return {
    id: "fence",
    title: "Math equation",
    matches: (language) => engine.fenceMode(language) !== null,
    component: Fence,
    action: ({ code }) => <FenceExpand code={code} />,
  };
}
