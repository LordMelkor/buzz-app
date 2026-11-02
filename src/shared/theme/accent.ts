import type { CSSProperties } from "react";
import { ACCENTS } from "../design-system/tokens/brand";

// Device-local color for messages, send and sidebar row states.
// Shared controls stay neutral; contrast changes message bubbles.
export { ACCENTS };
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "citrus";
export const ACCENT_KEY = "buzz-accent.v1";
/** The former message-bubble preference; read once when no accent is saved. */
export const LEGACY_BUBBLE_KEY = "buzz-bubble-color.v1";

export function parseAccent(value: unknown): Accent {
  if (
    value === "chartreuse" ||
    value === "lime" ||
    value === "pear" ||
    value === "jade"
  )
    return "citrus";
  if (value === "flame") return "bee";
  if (value === "gray") return "mono";
  return ACCENTS.includes(value as Accent) ? (value as Accent) : DEFAULT_ACCENT;
}

/** A saved bubble color carries over to its accent; its old "Default" does not. */
const LEGACY_BUBBLE_ACCENTS: Readonly<Record<string, Accent>> = {
  blue: "cobalt",
  cyan: "cobalt",
  indigo: "cobalt",
  green: "citrus",
  orange: "bee",
  pink: "magenta",
  red: "magenta",
  lilac: "iris",
  purple: "iris",
};
export function parseLegacyBubbleColor(value: unknown): Accent {
  return (
    (typeof value === "string" ? LEGACY_BUBBLE_ACCENTS[value] : undefined) ??
    DEFAULT_ACCENT
  );
}

export type Contrast = "low" | "high";
export const CONTRAST_KEY = "buzz-contrast.v1";
export const parseContrast = (value: unknown): Contrast =>
  value === "high" ? "high" : "low";

// Send and accent swatches always show their family's strong fill, in either mode.
export const accentButtonStyle = {
  "--affordance-prominent": "var(--affordance-accent-prominent)",
  "--affordance-prominent-hover": "var(--affordance-accent-prominent-hover)",
  "--affordance-prominent-pressed":
    "var(--affordance-accent-prominent-pressed)",
  "--text-on-prominent": "var(--text-on-accent)",
} as CSSProperties;
