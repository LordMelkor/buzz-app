import { ACCENTS, DEFAULT_ACCENT, type Accent } from "./accent";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("src/shared/styles/tokens.css", "utf8");
const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries(
    [...(match[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2]?.trim(),
    ]),
  ),
);

// Resolve the real shared palette and host aliases in cascade order. The host
// no longer owns literal colors; a missing or cyclic alias must fail the test.
function resolvedPalette(
  mode: "light" | "dark",
  accent: Accent = DEFAULT_ACCENT,
  contrastMode: "low" | "high" = "low",
) {
  const source = (
    readFileSync("src/shared/design-system/styles/tokens.css", "utf8") +
    "\n" +
    css
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const values: Record<string, string> = {};
  for (const [, selector = "", body = ""] of source.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selector.includes(":root") && !selector.includes(".dark")) continue;
    if (
      selector.includes('data-accent="') &&
      !selector.includes(`data-accent="${accent}"`)
    )
      continue;
    if (
      selector.includes('data-color-level="') &&
      !selector.includes(
        `data-color-level="${contrastMode === "low" ? "touch" : contrastMode}"`,
      )
    )
      continue;
    const dark =
      selector.includes('data-color-mode="dark"') || selector.includes(".dark");
    if (dark && mode !== "dark") continue;
    for (const [, name = "", value = ""] of body.matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ))
      values[name] = value.trim();
  }
  return resolveAliases(values);
}

function resolveAliases(values: Record<string, string>) {
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`Cyclic token: ${name}`);
    seen.add(name);
    const value = values[name];
    if (!value) throw new Error(`Missing token: ${name}`);
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    return alias?.[1] ? resolve(alias[1], seen) : value;
  };
  return Object.fromEntries(
    Object.keys(values).map((name) => [name, resolve(name)]),
  );
}

function luminance(hex: string | undefined) {
  if (!hex) throw new Error("Missing contrast color");
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const rgb = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb.reduce(
    (sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0),
    0,
  );
}
/** A see-through `rgb(r g b / a%)` fill as the flat colour it makes on `base`. */
function over(fill: string | undefined, base: string | undefined) {
  const overlay = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)%\)$/.exec(fill ?? "");
  if (!overlay || !base) return fill;
  const alpha = Number(overlay[4]) / 100;
  return `#${[1, 2, 3]
    .map((i) =>
      Math.round(
        Number(overlay[i]) * alpha +
          Number.parseInt(base.slice(i * 2 - 1, i * 2 + 1), 16) * (1 - alpha),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
function contrast(a: string | undefined, b: string | undefined) {
  const x = luminance(a);
  const y = luminance(b);
  const low = Math.min(x, y);
  const high = Math.max(x, y);
  return (high + 0.05) / (low + 0.05);
}

it("both palettes define every color/elevation role, with shared radii", () => {
  expect(blocks).toHaveLength(2);
  expect(
    Object.keys(blocks[0])
      .filter((k) => !k.startsWith("--radius-"))
      .sort(),
  ).toEqual(Object.keys(blocks[1]).sort());
});

it.each([0, 1])(
  "palette %i has AA text/control token pairs (not a rendered audit)",
  (index) => {
    const t = resolvedPalette(index === 0 ? "light" : "dark");
    const textPairs: [string, string][] = [
      ["--text-standard", "--bg-app"],
      ["--text-subtle", "--bg-app"],
      ["--text-metadata", "--bg-app"],
      ...[
        "--surface",
        "--surface-accent",
        "--surface-elevated",
        "--surface-control",
        "--surface-input",
        "--surface-hover",
      ].flatMap((background) =>
        ["--text", "--text-muted"].map((foreground): [string, string] => [
          foreground,
          background,
        ]),
      ),
      ["--on-primary", "--primary"],
      ["--on-action", "--action"],
      ["--on-selected", "--selected"],
      ["--warning", "--warning-surface"],
      ["--success", "--success-surface"],
      ["--danger", "--surface"],
      ["--link", "--surface"],
    ];
    for (const [fg, bg] of textPairs)
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    for (const bg of [
      "--surface",
      "--surface-input",
      "--surface-elevated",
      "--selected",
    ]) {
      expect(
        contrast(t["--focus"], t[bg]),
        `focus on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(t["--border-input"], t["--surface"]),
    ).toBeGreaterThanOrEqual(3);
  },
);

it("a scoped dark surface rebinds glass roles inherited from a light app", () => {
  // Custom properties inherit computed values, not unresolved var() expressions.
  // Freeze the light root first, then cascade declarations on the .dark child.
  const values = resolvedPalette("light");
  const source = readFileSync(
    "src/shared/design-system/styles/tokens.css",
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector = "", body = ""] of source.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selector.includes(".dark")) continue;
    for (const [, name = "", value = ""] of body.matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ))
      values[name] = value.trim();
  }
  const scoped = resolveAliases(values);
  const dark = resolvedPalette("dark");
  const light = resolvedPalette("light");
  for (const role of [
    "--bg-glass-primary",
    "--bg-glass-primary-hover",
    "--bg-glass-secondary",
    "--bg-glass-secondary-hover",
  ]) {
    expect(scoped[role], role).toBe(dark[role]);
    expect(scoped[role], role).not.toBe(light[role]);
  }
});

it.each(["light", "dark"] as const)(
  "message text and links contrast with both bubble fills in %s",
  (mode) => {
    const palette = resolvedPalette(mode);
    // Own bubbles carry the accent's paired ink; received keep normal text.
    for (const surface of ["--surface-message", "--surface-message-own"]) {
      for (const text of surface === "--surface-message-own"
        ? ["--text-message-own", "--text-message-link-own"]
        : ["--text-standard", "--text-subtle", "--text-link"]) {
        expect(
          contrast(palette[text], palette[surface]),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Received bubbles stay neutral; own bubbles use the soft accent pair.
    expect(palette["--surface-message"]).toBe(palette["--bubble-received"]);
    expect(palette["--surface-message-own"]).toBe(palette["--accent-4"]);
    expect(palette["--text-message-own"]).toBe(palette["--accent-12"]);
  },
);

it.each(ACCENTS)(
  "%s message fill keeps text and send icons readable in both modes",
  (color) => {
    for (const mode of ["light", "dark"] as const)
      for (const contrastMode of ["low", "high"] as const) {
        const palette = resolvedPalette(mode, color, contrastMode);
        const where = `${color}/${mode}`;
        // Highlights come from the family's tint, never a mixed bubble color.
        expect(palette["--surface-message-highlight"], where).toBe(
          palette["--accent-3"],
        );
        for (const [text, fill] of [
          ["--text-row-selected-detail", "--surface-row-selected-detail"],
          ["--text-message-own", "--surface-message-own"],
          ["--text-message-link-own", "--surface-message-own"],
          ["--text-on-prominent", "--affordance-prominent"],
          ["--text-navigation-selected", "--surface-navigation-selected"],
          ["--text-sidebar-selected", "--surface-sidebar-selected"],
          ["--text-sidebar-hover", "--affordance-sidebar-hover"],
          ["--text-on-accent", "--affordance-accent-prominent"],
          ["--text-control-selected", "--surface-control-selected"],
          ["--text-navigation-selected", "--bg-chrome-selected"],
          // Supported legacy/plugin markup must keep the same paired ink.
          ["--on-primary", "--primary"],
          ["--text-standard", "--surface-message"],
          ["--text-message-link", "--surface-message"],
        ] as const)
          expect(
            contrast(palette[text], palette[fill]),
            `${text} on ${fill} in ${where}`,
          ).toBeGreaterThanOrEqual(4.5);
      }
  },
);

it("the default Citrus accent keeps its strong fill and paired black ink", () => {
  for (const mode of ["light", "dark"] as const) {
    const palette = resolvedPalette(mode);
    expect(palette["--affordance-accent-prominent"]).toBe("#beda36");
    expect(palette["--text-on-accent"]).toBe("#000000");
  }
});

it.each(["light", "dark"] as const)(
  "%s reading surfaces stay neutral across accents",
  (mode) => {
    const baseline = resolvedPalette(mode);
    for (const accent of ACCENTS) {
      const palette = resolvedPalette(mode, accent, "high");
      for (const role of [
        "--bg-app",
        "--surface-panel",
        "--surface-popover",
        "--surface-message",
        "--text-standard",
        "--text-subtle",
        "--border-standard",
      ]) {
        expect(palette[role], `${accent}: ${role}`).toBe(baseline[role]);
      }
    }
  },
);

it.each(ACCENTS)(
  "%s vibe changes bubbles while controls and sidebar states stay consistent",
  (accent) => {
    for (const mode of ["light", "dark"] as const) {
      const high = resolvedPalette(mode, accent, "high");
      const low = resolvedPalette(mode, accent, "low");
      expect(high["--surface-message-own"]).toBe(high["--accent-9"]);
      expect(high["--surface-message"]).toBe(high["--bubble-received"]);
      expect(low["--surface-message"]).toBe(low["--bubble-received"]);
      expect(low["--surface-message-own"]).toBe(low["--accent-4"]);
      expect(high["--surface-sidebar-selected"]).toBe(high["--accent-9"]);
      expect(high["--text-sidebar-selected"]).toBe(high["--accent-contrast"]);
      const mono = resolvedPalette(mode, "mono");
      for (const role of [
        "--affordance-prominent",
        "--affordance-prominent-hover",
        "--affordance-prominent-pressed",
        "--text-on-prominent",
        "--surface-control-selected",
        "--text-control-selected",
        "--surface-navigation-selected",
        "--text-navigation-selected",
        "--bg-chrome-selected",
        "--affordance-floating-hover",
        "--affordance-floating-selected",
        "--affordance-popover-selected",
        "--affordance-panel-hover",
        "--text-link",
        "--affordance-link-hover",
        "--text-accent",
        "--border-accent",
        "--affordance-accent",
      ]) {
        expect(high[role], `${mode}/${role}`).toBe(mono[role]);
        expect(low[role], `${mode}/${role}`).toBe(mono[role]);
      }
      for (const role of [
        "--surface-sidebar-selected",
        "--text-sidebar-selected",
        "--affordance-sidebar-hover",
        "--affordance-accent-prominent",
      ])
        expect(high[role], role).toBe(low[role]);
    }
  },
);

it.each(ACCENTS)(
  "%s mention chips stay readable and apart from every bubble",
  (color) => {
    for (const level of ["low", "high"] as const)
      for (const mode of ["light", "dark"] as const) {
        const palette = resolvedPalette(mode, color, level);
        const where = `${color}/${level}/${mode}`;
        // A chip is the colour its overlay makes on the bubble beneath it.
        const chip = (fill: string) =>
          over(
            palette[fill],
            palette[
              fill.includes("-own")
                ? "--surface-message-own"
                : "--surface-message"
            ],
          );
        for (const [text, fill] of [
          ["--text-mention", "--affordance-mention"],
          ["--text-mention", "--affordance-mention-hover"],
          ["--text-mention-own", "--affordance-mention-own"],
          ["--text-mention-own", "--affordance-mention-own-hover"],
          ["--text-mention-self", "--affordance-mention-self"],
          ["--text-mention-self", "--affordance-mention-self-hover"],
        ] as const)
          expect(
            contrast(palette[text], chip(fill)),
            `${text} on ${fill} in ${where}`,
          ).toBeGreaterThanOrEqual(4.5);
        // The own chip never repaints the bubble it sits on.
        expect(chip("--affordance-mention-own"), where).not.toBe(
          palette["--surface-message-own"],
        );
        // Hovering a chip in your own bubble always shows a change.
        expect(chip("--affordance-mention-own-hover"), where).not.toBe(
          chip("--affordance-mention-own"),
        );
        // Ordinary mentions stay neutral at every level; a mention of you
        // takes the strong fill in both modes.
        expect(palette["--affordance-mention"], where).toBe(
          resolvedPalette(mode, color, "low")["--affordance-mention"],
        );
        expect(palette["--affordance-mention-self"], where).toBe(
          palette["--affordance-accent-prominent"],
        );
        expect(palette["--text-mention-self"], where).toBe(
          palette["--text-on-accent"],
        );
      }
  },
);
