/** Palette metadata for Appearance references and proposed plugin artwork. */
export const BRAND_SHADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
/** Canonical Appearance order; re-exported by shared/theme/accent.ts. */
export const ACCENTS = [
  "bee",
  "magenta",
  "iris",
  "cobalt",
  "citrus",
  "mono",
] as const;
/** Retained artwork palettes are independent of selectable Appearance accents. */
export const PALETTE_FAMILIES = [...ACCENTS, "flame", "jade"] as const;
/** Proposed artwork mapping uses existing theme-aware palette families independently
 * of the existing Appearance choices above. */
export const BRAND_GRADIENTS = [
  {
    name: "Communication",
    category: "communication",
    start: "cyan-9",
    end: "jade-9",
    compromise:
      "Cyan to jade gives Communication a teal/green identity distinct from Agents.",
  },
  {
    name: "Agents",
    category: "agents",
    start: "blue-9",
    end: "iris-9",
    compromise:
      "Existing Iris supplies violet beneath lighter blue in both themes.",
  },
  {
    name: "Agent tools",
    category: "agent-tools",
    start: "purple-9",
    end: "magenta-9",
    compromise:
      "Purple to the existing Magenta fill gives agent tools a violet-to-rose identity.",
  },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    start: "orange-9",
    end: "flame-9",
    compromise:
      "Orange to the existing Flame fill gives developer tools a warm ember identity.",
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    start: "red-9",
    end: "magenta-9",
    compromise:
      "Red to existing Magenta gives people a scarlet-to-rose identity.",
  },
  {
    name: "Productivity",
    category: "productivity",
    start: "amber-9",
    end: "flame-9",
    compromise:
      "Golden amber to Flame gives productivity a warm sunset identity.",
  },
] as const;
