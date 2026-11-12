import katex, { type KatexOptions } from "katex";
import "katex/contrib/mhchem";
import type { RenderOptions, RenderOutcome } from "../contract";
import { renderRefusal } from "./preflight";

type Cached =
  | { ok: true; element: HTMLElement }
  | Extract<RenderOutcome, { ok: false }>;
const cache = new Map<string, Cached>();
const assignments = [
  "def",
  "gdef",
  "edef",
  "xdef",
  "let",
  "futurelet",
  "newcommand",
  "renewcommand",
  "providecommand",
];
const refuseAssignment = () => {
  throw new katex.ParseError("Sender-defined macros are not supported");
};
// Pinned KaTeX 0.16.47 expands tag/tag* to gdef df@tag (src/macros.ts),
// and nonumber/notag to gdef @eqnsw{0} (src/environments/array.ts).
// These are its only built-in assignment expansions. Reproduce just those
// zero-argument assignments; authored private names are refused before parsing.
function privateAssignment(context: object): string {
  const gullet = context as {
    future(): { text: string };
    popToken(): unknown;
    consumeArg(): { tokens: { text: string }[] };
    macros: { set(name: string, value: object, global: boolean): void };
  };
  const name = gullet.future().text;
  if (name !== "\\df@tag" && name !== "\\@eqnsw") return refuseAssignment();
  gullet.popToken();
  const { tokens } = gullet.consumeArg();
  gullet.macros.set(name, { tokens, numArgs: 0 }, true);
  return "";
}

function settings(
  display: boolean,
  fleqn = false,
  output: KatexOptions["output"] = "htmlAndMathml",
): KatexOptions {
  // Null-prototype options prevent inherited settings being consumed if another
  // trusted plugin has polluted Object.prototype (GHSA-238p-pmpm-9mq7).
  // Macros must remain a fresh normal object: 0.16's Namespace calls their
  // hasOwnProperty method directly (it does not read inherited macro entries).
  return Object.assign(Object.create(null), {
    displayMode: display,
    output,
    throwOnError: true,
    trust: false,
    strict: "ignore",
    maxSize: 20, // Both signs: katex@0.16.47.patch floors its shared size conversion.
    maxExpand: 1000,
    fleqn,
    // Namespace guards run before definition/alias expansion, including through
    // prefixes such as global/long. Built-in macros and mhchem remain available.
    macros: {
      ...Object.fromEntries(
        assignments.map((name) => [`\\${name}`, refuseAssignment]),
      ),
      "\\gdef": privateAssignment,
    },
  });
}
function errorOutcome(error: unknown): Extract<RenderOutcome, { ok: false }> {
  return Object.freeze(
    error instanceof katex.ParseError
      ? {
          ok: false as const,
          message: error.rawMessage,
          position: error.position,
        }
      : { ok: false as const, message: "Couldn't typeset this" },
  );
}

export function render(
  tex: string,
  display: boolean,
  options: RenderOptions = {},
): RenderOutcome {
  if (tex.length > 10_000)
    return { ok: false, message: "Too long to typeset", tooLarge: true };
  const refusal = renderRefusal(tex);
  if (refusal) return refusal;
  const fleqn = options.fleqn ?? false;
  const key = JSON.stringify([display, fleqn, tex]);
  let value = cache.get(key);
  if (value) cache.delete(key);
  else {
    try {
      const detached = document.createElement("span");
      katex.render(tex, detached, settings(display, fleqn));
      const element = detached.firstElementChild;
      if (!(element instanceof HTMLElement)) throw Error("Missing KaTeX root");
      value = { ok: true, element };
    } catch (error) {
      value = errorOutcome(error);
    }
  }
  cache.set(key, value);
  if (cache.size > 512) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value.ok
    ? { ok: true, element: value.element.cloneNode(true) as HTMLElement }
    : value;
}

export function toMathML(tex: string, display: boolean): string | undefined {
  if (tex.length > 10_000 || renderRefusal(tex)) return undefined;
  try {
    const markup = katex.renderToString(
      tex,
      settings(display, false, "mathml"),
    );
    return /<math[\s\S]*<\/math>/.exec(markup)?.[0];
  } catch {
    return undefined;
  }
}
