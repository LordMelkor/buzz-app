import type { Root } from "hast";

export const MAX_ZIP_ENTRIES = 10_000;
/** Inflated bytes of one zip part, and of all inflated parts together. */
export const MAX_PART_BYTES = 32 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 160 * 1024 * 1024;
/** Embedded pictures kept as blobs; later pictures become the alt chip. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_SHEETS = 64;
export const MAX_SHEET_ROWS = 5_000;
export const MAX_SHEET_COLUMNS = 200;
export const MAX_SHEET_CELLS = 200_000;
export const MAX_SLIDES = 500;

/** Which office view a file opens in. Decided from the name before a load
 * (labels, cards) and from the content after it for the rendered view. */
export type OfficeFamily = "document" | "sheets" | "slides" | "preview";

/** Key of an embedded picture: the value of `img src` in an office tree, and
 * of `media` in slide shapes. Always `mdv-media:<n>`. */
export type MediaRef = `mdv-media:${number}`;

/** Pictures carried inside the file. ui/ makes object URLs and revokes them. */
export type EmbeddedMedia = ReadonlyMap<MediaRef, Blob>;

/** `#rrggbb` or `#rrggbbaa`, validated by data/. */
export type Color = string;

/** Points (1/72 in), relative to the slide, or to the parent group. */
export type Box = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** A run of slide or chart text. Sizes are points. */
export type TextRun =
  | Readonly<{
      kind: "text";
      text: string;
      size: number;
      /** A validated family name: letters, digits, space, `-` or `_`, 1-64 chars. */
      font?: string;
      bold?: true;
      italic?: true;
      underline?: true;
      strike?: true;
      color?: Color;
      highlight?: Color;
      baseline?: "super" | "sub";
      caps?: "all" | "small";
      /** The link as written in the file; ui/ passes it to resolveLink. */
      href?: string;
    }>
  | Readonly<{ kind: "break" }>;

export type TextParagraph = Readonly<{
  runs: readonly TextRun[];
  align: "left" | "center" | "right" | "justify";
  /** Points from the box's left inset to the text; indent applies to the first line (negative hangs the bullet). */
  marginLeft: number;
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Line height as a multiple of the font size; absent means 1.2. */
  lineHeight?: number;
  /** Bullet text already numbered by data/ ("•", "3.", "c)"). */
  bullet?: Readonly<{
    text: string;
    color?: Color;
    size?: number;
    font?: string;
  }>;
  /** Size of an empty paragraph's line. */
  endSize: number;
}>;

export type TextBody = Readonly<{
  paragraphs: readonly TextParagraph[];
  anchor: "top" | "middle" | "bottom";
  inset: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  wrap: boolean;
  vertical?: "down" | "up";
}>;

export type Fill =
  | Readonly<{ kind: "solid"; color: Color }>
  /** angle in degrees, clockwise from left-to-right; at in 0..1. */
  | Readonly<{
      kind: "gradient";
      angle: number;
      stops: readonly Readonly<{ at: number; color: Color }>[];
    }>
  | Readonly<{ kind: "picture"; media: MediaRef }>;

export type Line = Readonly<{
  color: Color;
  width: number;
  dash?: "dash" | "dot" | "dash-dot";
  headArrow?: true;
  tailArrow?: true;
}>;

/** About the box centre: flip, then skew, then rotation. `skew` is a CSS
 * skewX angle in degrees, for shapes inside a group scaled unevenly. With
 * the box's own width and height, it lets any affine placement be drawn. */
export type Transform = Readonly<{
  rotation: number;
  skew?: number;
  flipH?: true;
  flipV?: true;
}>;

export type TableCellModel =
  | Readonly<{
      text: TextBody;
      fill?: Fill;
      colSpan: number;
      rowSpan: number;
      borders?: Readonly<{
        top?: Line;
        right?: Line;
        bottom?: Line;
        left?: Line;
      }>;
    }>
  /** Covered by a span from another cell. */
  | Readonly<{ merged: true }>;

export type Chart =
  | Readonly<{
      /** bar: horizontal bars; column: vertical. Combo charts give per-series types. */
      type: "bar" | "column" | "line" | "area" | "pie" | "doughnut" | "scatter";
      grouping: "standard" | "clustered" | "stacked" | "percent";
      title?: string;
      categories: readonly string[];
      series: readonly Readonly<{
        name: string;
        /** Bar, column, line or area inside a combo chart; else the chart's type. */
        type?: "bar" | "column" | "line" | "area";
        values: readonly (number | null)[];
        /** Scatter only. */
        x?: readonly (number | null)[];
        color: Color;
        /** Pie and doughnut: one colour per point. */
        pointColors?: readonly Color[];
        /** The file's chart group: series stack only within their group.
         * Absent: series of one kind stack together. */
        group?: number;
        /** The group's grouping, where it differs from the chart's. */
        grouping?: "standard" | "clustered" | "stacked" | "percent";
        /** This series' number format: true a percentage, false not.
         * Absent: the chart's `percent`. */
        percent?: boolean;
        /** Plotted against the file's second value axis, drawn on the far
         * side with its own scale. Absent: the first value axis. */
        secondary?: true;
        /** Scatter: plotted against the file's second horizontal axis, drawn
         * along the top with its own scale. Absent: the first. */
        secondaryX?: true;
      }>[];
      legend?: "top" | "bottom" | "left" | "right";
      /** Every series' number format looks like a percentage: the value axis
       * reads in percent. A series' own `percent` overrides it for its values. */
      percent?: true;
    }>
  /** A chart type the reader doesn't draw (radar, stock, surface, bubble, …). */
  | Readonly<{ type: "unsupported"; title?: string }>;

export type SlideShape =
  | Readonly<{
      kind: "shape";
      box: Box;
      transform: Transform;
      /** SVG path data in box space (0..width × 0..height), M/L/C/Q/A/Z with
       * numbers only, built by data/. Absent: a rectangle. */
      path?: string;
      fill?: Fill;
      line?: Line;
      text?: TextBody;
      href?: string;
    }>
  | Readonly<{
      kind: "picture";
      box: Box;
      transform: Transform;
      /** null: show the alt chip (over a cap, an SVG/TIFF, unreadable). */
      media: MediaRef | null;
      /** A linked picture (TargetMode="External"): https only, shown after Load images. */
      remote?: string;
      /** Fractions of the picture cut from each side. */
      crop?: Readonly<{
        top: number;
        right: number;
        bottom: number;
        left: number;
      }>;
      alt: string;
      line?: Line;
    }>
  | Readonly<{
      kind: "table";
      box: Box;
      columns: readonly number[];
      rows: readonly Readonly<{
        height: number;
        cells: readonly TableCellModel[];
      }>[];
    }>
  | Readonly<{ kind: "chart"; box: Box; chart: Chart }>
  /** children's boxes are already in the group's own box space. */
  | Readonly<{
      kind: "group";
      box: Box;
      transform: Transform;
      children: readonly SlideShape[];
    }>
  /** Something the reader can't draw (video, audio, OLE object, ink): a labelled box. */
  | Readonly<{ kind: "object"; box: Box; label: "video" | "audio" | "object" }>;

export type Slide = Readonly<{
  /** The slide's number in the file (hidden slides keep their numbers). */
  number: number;
  background?: Fill;
  shapes: readonly SlideShape[];
  /** The title placeholder's text, else "". */
  title: string;
  /** Speaker notes as plain text, "" when none. */
  notes: string;
  /** All slide text in reading order, for Copy text. */
  text: string;
}>;

export type Sheet =
  | Readonly<{
      kind: "cells";
      name: string;
      /** Sanitized hast: one table, a header row of column letters
       * (th scope=col) and a row-number column (th scope=row). */
      tree: Root;
      /** Rows and columns in the sheet's used range, before caps and hiding. */
      rows: number;
      columns: number;
      /** Left out by MAX_SHEET_ROWS / MAX_SHEET_COLUMNS / MAX_SHEET_CELLS. */
      truncated?: true;
      hiddenRows: number;
      hiddenColumns: number;
      /** Shown formula cells with no saved value, drawn empty (the reader
       * never calculates). Omitted when there are none. */
      unsaved?: number;
      /** Charts drawn on this sheet, in anchor order. */
      charts: readonly Chart[];
      /** The shown cells as TSV, for Copy. */
      text: string;
    }>
  | Readonly<{ kind: "chart"; name: string; chart: Chart }>;

export type OfficeDocument =
  | Readonly<{
      family: "document";
      /** A ParsedDocument of kind "markdown" built from the file: the office
       * schema (§11.4), outline, words and reading time. */
      parsed: ParsedDocument;
      /** Charts referenced from the tree by `figure data-mdv-chart="<n>"`. */
      charts: readonly Chart[];
      /** doc and ppt show text only; the UI says so. RTF keeps its formatting. */
      textOnly?: "doc" | "ppt";
      /** The tree stops at the last whole block that fits the render budget;
       * the UI says the rest isn't shown. */
      truncated?: true;
    }>
  | Readonly<{
      family: "sheets";
      sheets: readonly Sheet[];
      /** Hidden and very-hidden sheets, left out. */
      hiddenSheets: number;
      /** Sheets past MAX_SHEETS, left out. */
      moreSheets: number;
    }>
  | Readonly<{
      family: "slides";
      /** Points. */
      size: Readonly<{ width: number; height: number }>;
      slides: readonly Slide[];
      hiddenSlides: number;
      /** Slides past MAX_SLIDES or the presentation budget, left out. */
      moreSlides: number;
    }>
  | Readonly<{
      family: "preview";
      app: "Pages" | "Keynote" | "Numbers";
      /** The file's own first-page picture. */
      picture: MediaRef;
      width: number;
      height: number;
    }>;

export type OfficeResult =
  | Readonly<{
      ok: true;
      office: Readonly<{
        bytes: number;
        doc: OfficeDocument;
        media: EmbeddedMedia;
        macros?: true;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "unreadable" | "password" | "too-large" | "not-text";
      }>;
    }>;

export type OutlineItem = Readonly<{
  depth: 1 | 2 | 3;
  text: string;
  id: string;
}>;
export type ParsedDocument = Readonly<{
  kind: "markdown" | "text";
  tree: Root;
  outline: readonly OutlineItem[];
  words: number;
  readingMinutes: number;
  plain?: "too-large" | "too-deep";
}>;

export const MAX_RENDER_CHARS = 1_000_000;
export const MAX_RENDER_DEPTH = 100;
