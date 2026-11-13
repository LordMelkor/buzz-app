import type { EmbeddedMedia } from "./office-types";

export const PAGE_HEAD_MARKER = "<!--mdv-head-->";

export type PageDocument = Readonly<{
  /** Whole sanitized document, with PAGE_HEAD_MARKER first in its head. */
  html: string;
  /** Original hrefs, addressed by data-mdv-link indices. */
  links: readonly string[];
  /** Original image inputs or carried media refs, addressed by data-mdv-image. */
  images: readonly string[];
  /** Pictures carried inside the page; the UI owns their object URLs. */
  media: EmbeddedMedia;
}>;
