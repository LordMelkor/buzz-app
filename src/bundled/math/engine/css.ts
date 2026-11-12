import source from "katex/dist/katex.css?raw";

function fontField(pattern: RegExp, rule: string): string {
  const value = pattern.exec(rule)?.[1];
  if (value === undefined) throw new TypeError("Missing @font-face field");
  return value;
}

export const css = source.replace(/@font-face\s*\{[^}]*\}/g, "");
export const fontDescriptors = [
  ...source.matchAll(/@font-face\s*\{([^}]*)\}/g),
].map(([, rule = ""]) => ({
  family: fontField(/font-family\b:\s*"([^"]+)"/, rule),
  file: fontField(/url\(([^)]+\.woff2)\)/, rule),
  style: fontField(/font-style:\s*([^;]+);/, rule),
  weight: fontField(/font-weight:\s*([^;]+);/, rule),
}));
