import { expect, test } from "vitest";
import {
  adoptionFindings,
  isAdoptionSource,
} from "../../../scripts/design-system/check-adoption.mjs";

test("adoption guard catches utilities, CSS and renderer string reads", () => {
  for (const source of [
    'className="text-red-12"',
    "color: var(--purple-3)",
    'color("--purple-3")',
    'className="text-cyan-12"',
    "color: var(--orange-3)",
  ]) {
    expect(adoptionFindings("src/example.tsx", source)).toHaveLength(1);
  }
  expect(
    adoptionFindings(
      "src/example.tsx",
      '/* var(--red-12) */\nclassName="text-danger"',
    ),
  ).toEqual([]);
});

test("adoption guard covers every Appearance family and explicit mode owner", () => {
  for (const family of [
    "bee",
    "citrus",
    "mono",
    "gray",
    "chartreuse",
    "flame",
    "magenta",
    "iris",
    "cobalt",
    "jade",
  ]) {
    for (const source of [
      `color: var(--${family}-9)`,
      `color: var(--${family}-11-light)`,
      `color: var(--${family}-12-dark)`,
      ...["contrast", "ink", "pressed", "link", "link-hover"].map(
        (role) => `color: var(--${family}-${role}-dark)`,
      ),
      `className="text-${family}-9"`,
    ])
      expect(adoptionFindings("src/example.tsx", source)).toHaveLength(1);
  }
});

test("feature layout remains local but cannot repaint shared controls", () => {
  expect(
    adoptionFindings(
      "src/example.module.css",
      ".history button { padding: var(--space-2); color: var(--text-subtle) }",
    ),
  ).toHaveLength(2);
  expect(
    adoptionFindings(
      "src/example.module.css",
      ".history { padding: var(--space-2) } .history button { margin: var(--space-2) }",
    ),
  ).toEqual([]);
  expect(
    adoptionFindings(
      "src/bundled/emoji/Emoji.module.css",
      ".gifGrid button { padding: 0; background: var(--affordance-subtle) }",
    ),
  ).toEqual([]);
});

test("production recipes and plugin examples are covered; swatches and tests are separate", () => {
  for (const file of [
    "src/app/Settings.tsx",
    "src/shared/design-system/styles/chips.css",
    "src/bundled/terminal/appearance.ts",
    "examples/plugins/notes/plugin.js",
  ])
    expect(isAdoptionSource(file)).toBe(true);
  for (const file of [
    "src/shared/design-system/styles/tokens.css",
    "src/shared/design-system/styles/flex-workspace.css",
    "src/example.test.ts",
  ])
    expect(isAdoptionSource(file)).toBe(false);
});
