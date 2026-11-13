import { formatExtension } from "./formats";
import { formattedJson } from "./json";
import { prepareMdx } from "./mdx";

/** Run once on the saved text, then index and slice this display text together.
 * Callers retain the saved text separately for Copy. */
export function prepareFileText(
  text: string,
  name: string,
  mime?: string,
): Readonly<{
  text: string;
  formatted?: true;
  plain?: "too-large";
}> {
  const ext = formatExtension(name, mime);
  if (ext === "mdx") {
    const prepared = prepareMdx(text);
    return prepared === undefined
      ? { text, plain: "too-large" }
      : { text: prepared };
  }
  const formatted =
    ext === "json" ? formattedJson(text, "display.json") : undefined;
  return formatted === undefined
    ? { text }
    : { text: formatted, formatted: true };
}
