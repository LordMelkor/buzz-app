import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tokens = readFileSync(
  join(root, "src/shared/design-system/styles/tokens.css"),
  "utf8",
);

// Exercise the real CLI against isolated stylesheet mutations. No repository
// files are changed, and a green status proves the guard actually ran.
function check(css) {
  const fixture = mkdtempSync(join(tmpdir(), "buzz-contrast-"));
  try {
    mkdirSync(join(fixture, "scripts/design-system"), { recursive: true });
    mkdirSync(join(fixture, "src/shared/design-system/styles"), {
      recursive: true,
    });
    for (const name of ["check-contrast.mjs", "apca.mjs"])
      copyFileSync(
        join(root, "scripts/design-system", name),
        join(fixture, "scripts/design-system", name),
      );
    writeFileSync(
      join(fixture, "src/shared/design-system/styles/tokens.css"),
      css,
    );
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts/design-system/check-contrast.mjs")],
      { encoding: "utf8" },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("semantic contrast contract", () => {
  it("checks the current text and state-boundary pairs in both modes", () => {
    const result = check(tokens);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "checked text and control/state boundaries",
    );
    expect(result.output).not.toContain("accepted link contrast");
    expect(result.output.match(/\(accepted Away contrast\)/g)).toHaveLength(9);
    expect(result.output).toContain("not a contrast pass");
    expect(result.output).not.toContain("exceptions no longer needed");
  });

  it.each([
    [
      "light foreground",
      "--text-link: var(--text-standard);",
      "--text-link: var(--neutral-7);",
      "on --affordance-selected",
    ],
    [
      "dark foreground",
      "--text-link: var(--text-standard);",
      "--text-link: var(--neutral-8);",
      "on --surface-panel",
    ],
    [
      "light surface",
      "--neutral-3: #e8e8e8;",
      "--neutral-3: #999999;",
      "on --affordance-selected",
    ],
    [
      "dark surface",
      "--neutral-raised: #282828;",
      "--neutral-raised: #a4a4a4;",
      "on --surface-popover",
    ],
    [
      "another surface role",
      "--surface-inset: var(--neutral-2);",
      "--surface-inset: var(--neutral-7);",
      "on --surface-inset",
    ],
    [
      "hover role",
      "--affordance-link-hover: var(--affordance-subtle-hover);",
      "--affordance-link-hover: var(--neutral-7);",
      "on --affordance-link-hover",
    ],
    [
      "hover color",
      "--neutral-quiet-hover: #f1f1f2;",
      "--neutral-quiet-hover: #737373;",
      "on --affordance-link-hover",
    ],
  ])(
    "rejects unreadable link text after a change to %s",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toMatch(
        new RegExp(`--text-link \\([^\\n]+\\) ${pairing}`),
      );
    },
  );

  it.each([
    [
      "wrong dark ink",
      "--magenta-contrast-dark: #ffffff;",
      "--magenta-contrast-dark: #000000;",
      "magenta/neutral/dark",
    ],
    [
      "unresolved ink",
      "--magenta-contrast-light: #ffffff;",
      "--magenta-contrast-light: var(--missing-ink);",
      "magenta/neutral/light: unresolved accent pair",
    ],
    [
      "faint sidebar label",
      "--magenta-12-light: #42242f;",
      "--magenta-12-light: #feedf3;",
      "magenta/neutral/light --text-sidebar-hover",
    ],
  ])(
    "rejects a non-default accent family's %s",
    (_name, from, to, evidence) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replace(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(evidence);
    },
  );

  it.each(["--surface-base", "--surface-panel", "--surface-message"])(
    "rejects text selection that disappears on %s",
    (surface) => {
      const result = check(
        tokens.replaceAll(
          "--surface-text-selection: var(--neutral-12);",
          `--surface-text-selection: var(${surface});`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`--surface-text-selection on ${surface}`);
    },
  );

  it("rejects selection that disappears on a solid own bubble", () => {
    const result = check(
      tokens.replaceAll(
        "--surface-text-selection-own: var(--accent-ink);",
        "--surface-text-selection-own: var(--surface-message-own);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "--surface-text-selection-own on --surface-message-own",
    );
  });

  it("checks shared color groups at every applicable level", () => {
    const from = "--text-sidebar-hover: var(--accent-12);";
    expect(tokens).toContain(from);
    const result = check(
      tokens.replaceAll(from, "--text-sidebar-hover: var(--accent-6);"),
    );
    expect(result.status, result.output).toBe(1);
    for (const level of ["touch", "high"])
      expect(result.output).toContain(
        `citrus/${level}/light --text-sidebar-hover`,
      );
  });

  it("rejects a gray role left on an accent ground", () => {
    const from = "--text-sidebar-selected: var(--accent-contrast);";
    expect(tokens).toContain(from);
    const result = check(
      tokens.replaceAll(from, "--text-sidebar-selected: var(--neutral-10);"),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "citrus/touch/light: --text-sidebar-selected #525252 is gray on --surface-sidebar-selected",
    );
  });

  it.each([
    ["#000000", false],
    ["#262626", false],
    ["#404040", true],
  ])(
    "distinguishes black ink %s from gray on the brand-filled selection",
    (ink, gray) => {
      const from = "--text-sidebar-selected: var(--accent-contrast);";
      expect(tokens).toContain(from);
      const result = check(
        tokens.replaceAll(from, `--text-sidebar-selected: ${ink};`),
      );
      if (gray) {
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain(
          `citrus/high/light: --text-sidebar-selected ${ink} is gray on --surface-sidebar-selected`,
        );
      } else {
        // A literal ink applies to every family, so saturated accents may fail
        // contrast; only the gray verdict is under test here.
        expect(result.output).not.toContain(
          "is gray on --surface-sidebar-selected",
        );
      }
    },
  );

  it("rejects a shell color that hides navigation text", () => {
    const result = check(
      tokens.replace(
        "--bg-app: var(--neutral-quiet-hover);",
        "--bg-app: var(--neutral-7);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/light\s+--text-subtle .* on --bg-app/);
  });

  it("checks other text roles without a link exception", () => {
    const result = check(
      tokens.replaceAll(
        "--text-accent: var(--text-standard);",
        "--text-accent: var(--blue-9);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(
      /dark\s+--text-accent .* on --surface-popover/,
    );
  });

  it.each([
    [
      "metadata",
      "--neutral-9: #5f5f5f;",
      "--neutral-9: #666666;",
      "--text-metadata",
    ],
    [
      "accent hover",
      "--cobalt-10-light: #0968d6;",
      "--cobalt-10-light: #9a5cd0;",
      "--text-on-accent",
    ],
  ])(
    "rejects the former %s pair that clears APCA but fails WCAG AA",
    (_name, from, to, role) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replace(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(role);
      expect(result.output).toContain("needs 4.5:1");
    },
  );

  it.each([
    [
      "shade",
      "--shade-fill: rgb(0 0 0 / 10%);",
      "--shade-fill: rgb(0 0 0 / 45%);",
      "light --text-mention (",
      "on --affordance-mention (",
    ],
    [
      "tint",
      "--tint-hover-fill: rgb(255 255 255 / 20%);",
      "--tint-hover-fill: rgb(255 255 255 / 70%);",
      "dark --text-mention (",
      "on --affordance-mention-hover (",
    ],
  ])(
    "measures a see-through %s chip as the colour it makes on its bubble",
    (_name, from, to, text, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replace(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(text);
      expect(result.output).toContain(pairing);
    },
  );

  it("fails when an accent is missing an overlay it is measured on", () => {
    const from = "  --accent-overlay-soft-dark: var(--shade-soft-fill);\n";
    const bee = tokens.indexOf('[data-accent="bee"] {');
    const at = tokens.indexOf(from, bee);
    expect(at).toBeGreaterThan(bee);
    const result = check(tokens.slice(0, at) + tokens.slice(at + from.length));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "bee/high/dark: unresolved overlay pair --text-message-own on --affordance-reaction-own",
    );
  });

  it.each(["danger", "warning"])(
    "rejects the former low-contrast %s boundary",
    (role) => {
      const hue = role === "danger" ? "red" : "amber";
      const result = check(
        tokens.replaceAll(
          new RegExp(`--border-${role}: var\\(--${hue}-\\d+\\);`, "g"),
          `--border-${role}: var(--${hue}-8);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --border-${role} on --surface-panel`,
      );
      expect(result.output).toContain(
        `dark: --border-${role} on --surface-popover`,
      );
    },
  );

  it.each([
    ["online", "green"],
    ["avatar-online-border", "green"],
    ["away", "amber"],
    ["offline", "neutral"],
  ])("checks %s status on supported surfaces in both modes", (role, hue) => {
    const result = check(
      tokens.replaceAll(
        new RegExp(`--status-${role}: var\\(--${hue}-\\d+\\);`, "g"),
        `--status-${role}: var(--${hue}-5);`,
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      `light: --status-${role} on --surface-panel`,
    );
    expect(result.output).toContain(
      `dark: --status-${role} on --surface-popover`,
    );
  });

  it.each([["online", "green"]])(
    "rejects a %s outline that disappears on hover or selection",
    (role, hue) => {
      const result = check(
        tokens.replaceAll(
          `--status-avatar-${role}-border: var(--${hue}-11);`,
          `--status-avatar-${role}-border: var(--${hue}-10);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --status-avatar-${role}-border on --affordance-selected`,
      );
    },
  );

  it.each([
    [
      "fill",
      "--amber-10: #ffba18;",
      "--amber-10: #ffba19;",
      "light: --status-away on --surface-panel",
    ],
    [
      "surface",
      "--neutral-4: #dadada;",
      "--neutral-4: #dbdbdb;",
      "light: --status-away on --neutral-4",
    ],
    [
      "dark mode",
      "--amber-10: #ffd60a;",
      "--amber-10: #333333;",
      "dark: --status-away on --surface-popover",
    ],
    [
      "other role",
      "--status-offline: var(--neutral-8);",
      "--status-offline: var(--amber-10);",
      "light: --status-offline on --surface-panel",
    ],
  ])(
    "does not extend the Away exception to a changed %s",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(pairing);
    },
  );

  it.each(["warning", "success", "accent"])(
    "checks %s text against its semantic fill, not only the palette",
    (role) => {
      const [from, to] =
        role === "accent"
          ? [
              "--affordance-accent: var(--affordance-subtle);",
              "--affordance-accent: var(--neutral-7);",
            ]
          : [
              `--affordance-${role}: var(--${role === "warning" ? "amber" : "green"}-3);`,
              `--affordance-${role}: var(--${role === "warning" ? "amber" : "green"}-9);`,
            ];
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`--text-${role}`);
      expect(result.output).toContain(`on --affordance-${role}`);
    },
  );

  // Green-10 still clears the page surfaces and falls short only on the light
  // tinted own bubbles, through the -own pair. Purple-10 passes the whole
  // guard (3.01–3.22:1 on the dark bubbles), so purple-9 is the first step it
  // can see; purple-9 also fails the dark popover, but the pinned pairing is
  // the dark received bubble. At Buzzin’ the own bubble is solid accent-9,
  // which the base role never clears: pointing the -own pair back at it fails
  // the own-bubble pairing on the high level. Subtle grey falls short of that
  // fill on most families in both modes (1.04–2.98:1); the dark pairing from
  // the report, 1.07:1 on citrus, is the one pinned here.
  it.each([
    [
      "success",
      "--icon-success: var(--green-11);",
      "--icon-success: var(--green-10);",
      "--icon-success-own on --surface-message-own",
    ],
    [
      "categorical purple",
      "--icon-categorical-purple: var(--purple-11);",
      "--icon-categorical-purple: var(--purple-9);",
      "--icon-categorical-purple on --surface-message",
    ],
    [
      "high-level own success",
      "--icon-success-own: var(--text-message-link-own);",
      "--icon-success-own: var(--icon-success);",
      "/high/light: --icon-success-own on --surface-message-own",
    ],
    [
      "high-level own subtle",
      "--icon-subtle-own: var(--text-message-link-own);",
      "--icon-subtle-own: var(--icon-subtle);",
      "/high/dark: --icon-subtle-own on --surface-message-own",
    ],
  ])(
    "checks the %s state icon against the message bubbles, not only the page",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(pairing);
    },
  );
});
