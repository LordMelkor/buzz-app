// Shared source boundaries for opaque grammar in the bounded Markdown scans.
export function leadingYamlEnd(text: string): number {
  const opening = /^(?:\ufeff)?---[\t ]*(?:\r\n?|\n)/.exec(text);
  if (!opening) return 0;
  const closing = /(?:\r\n?|\n)---[\t ]*(?=\r|\n|$)/g;
  closing.lastIndex = opening[0].length - 1;
  const match = closing.exec(text);
  if (!match) return 0;
  let end = match.index + match[0].length;
  if (text[end] === "\r") end += text[end + 1] === "\n" ? 2 : 1;
  else if (text[end] === "\n") end++;
  return end;
}

export function mathOpening(body: string): number | undefined {
  return body.match(/^ {0,3}(\${2,})[^$]*$/)?.[1]?.length;
}

export function mathClosing(body: string, size: number): number | undefined {
  const count = body.match(/^ {0,3}(\$+)[\t ]*$/)?.[1]?.length;
  return count !== undefined && count >= size ? count : undefined;
}

/** The shared grammar promotes only a standalone, equal-run $$ inline span. */
export function standaloneMath(body: string): boolean {
  const opening = /^ {0,3}\$\$(?!\$)/.exec(body);
  if (!opening) return false;
  const runs = /\$+/g;
  runs.lastIndex = opening[0].length;
  for (let run = runs.exec(body); run; run = runs.exec(body)) {
    if (run[0].length !== 2) continue;
    return (
      run.index > opening[0].length &&
      /^[\t ]*$/.test(body.slice(runs.lastIndex))
    );
  }
  return false;
}
