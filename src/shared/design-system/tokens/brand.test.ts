import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ACCENTS, BRAND_GRADIENTS, PALETTE_FAMILIES } from "./brand";
import { PALETTE, ROLE_GROUPS } from "./registry";

const css = readFileSync(
  new URL("../styles/tokens.css", import.meta.url),
  "utf8",
);
const light = css.slice(0, css.indexOf(':root[data-color-mode="dark"]'));
const dark = css.slice(
  css.indexOf(':root[data-color-mode="dark"]'),
  css.indexOf("LAYER 1 — FAMILIES"),
);

it("maps all artwork endpoints to existing family steps in both themes", () => {
  expect(new Set(BRAND_GRADIENTS.map(({ category }) => category)).size).toBe(6);
  for (const gradient of BRAND_GRADIENTS) {
    for (const [part, palette] of [
      ["start", gradient.start],
      ["end", gradient.end],
    ] as const) {
      expect(`--${palette}`).toMatch(
        /^--(amber|blue|cyan|green|orange|purple|red|chartreuse|flame|magenta|iris|cobalt|jade)-(?:[1-9]|1[0-2])$/,
      );
      expect(css).toContain(
        `--art-plugin-${gradient.category}-${part}: var(--${palette});`,
      );
      for (const [name, mode] of [
        ["light", light],
        ["dark", dark],
      ] as const) {
        if (PALETTE_FAMILIES.some((family) => palette.startsWith(`${family}-`)))
          expect(mode).toContain(`--${palette}: var(--${palette}-${name});`);
        else expect(mode).toMatch(new RegExp(`--${palette}: #[a-f0-9]{6};`));
      }
    }
    const pattern = new RegExp(
      `--art-plugin-${gradient.category}-gradient: linear-gradient\\([\\s\\S]*?var\\(--art-plugin-${gradient.category}-start\\),[\\s\\S]*?var\\(--art-plugin-${gradient.category}-end\\)[\\s\\S]*?\\);`,
    );
    expect(css).toMatch(pattern);
  }
});

it("registers all public artwork with palette ownership and distinct hue families", () => {
  const roles = ROLE_GROUPS.flatMap(({ roles }) => roles);
  for (const gradient of BRAND_GRADIENTS)
    for (const part of ["start", "end", "gradient"]) {
      expect(
        roles.find(
          ({ variable }) =>
            variable === `--art-plugin-${gradient.category}-${part}`,
        ),
      ).toMatchObject({ status: "proposed", owner: "Settings plugin catalog" });
    }
  const pairs = new Set<string>();
  for (const gradient of BRAND_GRADIENTS) {
    const family = (step: string) => step.split("-")[0];
    expect(family(gradient.start)).not.toBe(family(gradient.end));
    const pair = `${gradient.start}/${gradient.end}`;
    expect(pairs.has(pair)).toBe(false);
    pairs.add(pair);
  }
  expect(css).not.toContain("PLUGIN ARTWORK PALETTE");
});

it("keeps Agents blue above violet with a lighter top in both themes", () => {
  expect(
    BRAND_GRADIENTS.find(({ category }) => category === "agents"),
  ).toMatchObject({ start: "blue-9", end: "iris-9" });
  const luminance = (hex: string) => {
    const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)]
      .map((part) => parseInt(part, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return channels.reduce(
      (sum, channel, index) =>
        sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
  };
  for (const [modeName, mode] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    const value = (token: string) => {
      const source = token === "iris-9" ? css : mode;
      const name = token === "iris-9" ? `${token}-${modeName}` : token;
      const match = source.match(new RegExp(`--${name}: #([a-f0-9]{6});`));
      if (!match?.[1]) throw new Error(`Missing palette token ${token}`);
      return match[1];
    };
    expect(luminance(value("blue-9"))).toBeGreaterThan(
      luminance(value("iris-9")),
    );
  }
});

it("gives every Appearance step explicit mode ownership and complete registry metadata", () => {
  for (const family of ACCENTS) {
    const block = css.match(
      new RegExp(String.raw`\[data-accent="${family}"\][^{]*\{([^}]+)`),
    )?.[1];
    const steps = PALETTE.find(({ id }) => id === family)?.steps;
    expect(steps).toHaveLength(12);
    for (let step = 1; step <= 12; step += 1) {
      expect(steps).toContainEqual(
        expect.objectContaining({ step, variable: `--${family}-${step}` }),
      );
      for (const [mode, declarations] of [
        ["light", light],
        ["dark", dark],
      ] as const) {
        expect(css).toMatch(
          new RegExp(`--${family}-${step}-${mode}: #[a-f0-9]{6};`),
        );
        expect(declarations).toContain(
          `--${family}-${step}: var(--${family}-${step}-${mode});`,
        );
        expect(block).toContain(
          `--accent-${step}-${mode}: var(--${family}-${step}-${mode});`,
        );
      }
    }
    for (const role of ["contrast", "ink", "pressed", "link", "link-hover"]) {
      for (const mode of ["light", "dark"]) {
        expect(block).toContain(
          `--accent-${role}-${mode}: var(--${family}-${role}-${mode});`,
        );
      }
    }
    expect(block).not.toMatch(/#[a-f0-9]{3,8}/);
  }
});
