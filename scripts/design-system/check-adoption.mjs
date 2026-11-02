/** Production UI chooses semantic roles; shared controls own their appearance. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

// These styles are only used by the design viewer's layout experiments.
const viewerStyles = new Set([
  "bento.css",
  "flex-workspace.css",
  "multi-panel-swap.css",
  "swap-workspace.css",
  "globals.css",
]);
const nativeRecipes = new Map([
  [
    "src/bundled/emoji/Emoji.module.css",
    new Set([".gifGrid button", ".gifGrid button:hover"]),
  ],
  [
    "src/features/messages/Messages.module.css",
    new Set(['.text input[type="checkbox"]']),
  ],
  // The media renderer owns HTML video ranges/playback and timed emoji actions.
  // These selectors target its native controls, never shared Button/IconButton.
  [
    "src/features/messages/VideoPlayer.module.css",
    new Set([
      ".controls button",
      '.controls input[type="range"],\n.volumeSlider input[type="range"]',
      ".speedMenu button",
      ".reactions > fieldset > button",
      ".controls button:enabled:hover,\n  .reactions > fieldset > button:enabled:hover",
      ".controls button:enabled:active,\n.reactions > fieldset > button:enabled:active",
      ".reactions > fieldset > button:focus-visible",
    ]),
  ],
  ["src/shared/InlineReference.module.css", new Set(["button.link"])],
]);
const visualProperty =
  /^(?:background(?:-.+)?|color|border(?:-.+)?|box-shadow|font(?:-.+)?|line-height|letter-spacing|padding(?:-.+)?|outline(?:-.+)?)$/;
const controlSelector =
  /(?:^|[\s>+~])(?:button|input|textarea|select)(?:[.#][\w-]+|\[[^\]]*\]|:[\w-]+)*$|\.buzz-(?:button|input|textarea|radio|checkbox)\b/;
const palette =
  /--(?:neutral|purple|red|green|amber|blue|cyan|orange|gray|chartreuse|bee|citrus|mono|flame|magenta|iris|cobalt|jade)-(?:\d+|action-pressed|contrast|ink|pressed|link(?:-hover)?)\b|\b(?:bg|text|border|outline|ring|fill|stroke|shadow|from|via|to)-(?:neutral|purple|red|green|amber|blue|cyan|orange|gray|chartreuse|bee|citrus|mono|flame|magenta|iris|cobalt|jade)-\d+\b/g;

export function adoptionFindings(file, source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (s) => " ".repeat(s.length));
  const findings = [];
  for (const match of code.matchAll(palette)) {
    findings.push({
      line: code.slice(0, match.index).split("\n").length,
      reason: `direct palette ${match[0]}; use a semantic role`,
    });
  }
  if (file.endsWith(".module.css")) {
    postcss.parse(code).walkRules((rule) => {
      // Host fallback explicitly excludes shared controls. GIF tiles, rendered
      // Markdown checkboxes and inline links have their own native contracts.
      if (rule.selector.includes(":not(:where([data-buzz-ui]")) return;
      if (
        !controlSelector.test(rule.selector) ||
        nativeRecipes.get(file)?.has(rule.selector)
      )
        return;
      rule.walkDecls((decl) => {
        if (visualProperty.test(decl.prop))
          findings.push({
            line: decl.source.start.line,
            reason: `${rule.selector} overrides control ${decl.prop}; use the shared recipe`,
          });
      });
    });
  }
  return findings;
}

export function isAdoptionSource(file) {
  if (
    !/\.(?:css|tsx?|js|mjs)$/.test(file) ||
    /(?:\.test\.|\.spec\.|fixture)/.test(file)
  )
    return false;
  if (
    file === "src/shared/design-system/styles/tokens.css" ||
    file === "src/shared/design-system/tokens/registry.ts"
  )
    return false;
  if (
    file.startsWith("src/shared/design-system/styles/") &&
    viewerStyles.has(file.split("/").at(-1))
  )
    return false;
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  const failures = [];
  for (const path of [
    ...walk(join(root, "src")),
    ...walk(join(root, "examples/plugins")),
  ]) {
    const file = relative(root, path);
    if (!isAdoptionSource(file)) continue;
    for (const finding of adoptionFindings(file, readFileSync(path, "utf8")))
      failures.push(`${file}:${finding.line}: ${finding.reason}`);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "✓ Adoption: production colors use roles; feature CSS preserves shared controls",
    );
}
