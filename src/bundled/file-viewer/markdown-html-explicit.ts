// CommonMark's terminator and parse5's comment terminator are distinct for
// processing instructions/CDATA. Keep both states without retaining payload.
export type ExplicitHtml = Readonly<{
  kind: "pi" | "cdata" | "declaration";
  visible: boolean;
  lineTail?: boolean;
}>;

export function explicitHtmlStart(line: string): ExplicitHtml | undefined {
  if (/^ {0,3}<\?/.test(line)) return { kind: "pi", visible: false };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return { kind: "cdata", visible: false };
  // The installed CommonMark parser accepts either ASCII case.
  if (/^ {0,3}<![A-Za-z]/.test(line))
    return { kind: "declaration", visible: false };
  return undefined;
}
export const explicitHtmlEnd = (state: ExplicitHtml): string =>
  state.kind === "pi" ? "?>" : state.kind === "cdata" ? "]]>" : ">";

export function explicitHtmlWrapper(state: ExplicitHtml | undefined): {
  open: string;
  close: string;
} {
  if (!state) return { open: "", close: "" };
  // A completed comment admits the rest of exactly one physical HTML line.
  // Unlike reopening a PI, it releases Markdown at the original line ending.
  if (state.lineTail) return { open: "<!-- -->", close: "" };
  if (state.kind === "declaration") return { open: "<!A", close: ">" };
  if (state.kind === "pi")
    return state.visible
      ? { open: "<? >", close: "<??>" }
      : { open: "<?", close: "?>" };
  return state.visible
    ? { open: "<![CDATA[>", close: "<!--]]>-->" }
    : { open: "<![CDATA[", close: "]]>" };
}
