import { required } from "./required";
import type { MediaRef } from "../office-types";
import { MAX_MEDIA_BYTES } from "../office-types";
import { attr, checkAbort, descendants, parseXml } from "./xml";
import { MAX_PACKAGE_XML_STRUCTURES, validateXml } from "./validate-xml";
import { MAX_PACKAGE_PIXELS, rasterPixels, rasterSignature } from "./raster";
import { pictureTypes } from "./picture-types";

export type Relationship = Readonly<{
  target: string;
  type: string;
  external: boolean;
}>;
/** Resolve package URIs only; returned names remain map keys, never disk paths. */
export function partPath(from: string, target: string): string | undefined {
  if (/^[a-z][\w+.-]*:|^\/\//i.test(target) || target.includes("\\"))
    return undefined;
  const path = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!path.length) return undefined;
      path.pop();
    } else {
      try {
        path.push(decodeURIComponent(segment));
      } catch {
        return undefined;
      }
    }
  }
  return path.join("/");
}

export class OfficePackage {
  readonly media = new Map<MediaRef, Blob>();
  private readonly documents = new Map<string, Document>();
  private readonly pictures = new Map<string, MediaRef | null>();
  private readonly relationshipMaps = new Map<
    string,
    ReadonlyMap<string, Relationship>
  >();
  private pictureTypes?: (path: string) => string | undefined;
  private mediaBytes = 0;
  private readonly validated = new Set<string>();
  private readonly xmlBudget = { remaining: MAX_PACKAGE_XML_STRUCTURES };
  private mediaPixels = 0;
  constructor(
    readonly parts: ReadonlyMap<string, Uint8Array>,
    readonly signal: AbortSignal,
  ) {}
  check(): void {
    checkAbort(this.signal);
  }
  contentType(path: string): string | undefined {
    this.pictureTypes ??= pictureTypes(this.xml("[Content_Types].xml"));
    return this.pictureTypes(path);
  }
  isRaster(path: string, bytes = this.parts.get(path)): boolean {
    return !!bytes && rasterSignature(bytes, this.contentType(path));
  }
  validate(path: string): Uint8Array | undefined {
    this.check();
    const bytes = this.parts.get(path);
    if (bytes && !this.validated.has(path)) {
      validateXml(bytes, this.xmlBudget);
      this.validated.add(path);
    }
    return bytes;
  }
  xml(path: string): Document | undefined {
    this.check();
    const bytes = this.validate(path);
    if (!bytes) return undefined;
    let doc = this.documents.get(path);
    if (!doc) {
      doc = parseXml(bytes, true);
      this.documents.set(path, doc);
    }
    return doc;
  }
  relationships(path: string): ReadonlyMap<string, Relationship> {
    this.check();
    const saved = this.relationshipMaps.get(path);
    if (saved) return saved;
    const folder = path.split("/");
    const name = folder.pop();
    const rels = this.xml([...folder, "_rels", `${name}.rels`].join("/"));
    const out = new Map<string, Relationship>();
    if (rels)
      for (const rel of descendants(rels, "Relationship")) {
        const id = attr(rel, "Id"),
          raw = attr(rel, "Target"),
          external = attr(rel, "TargetMode") === "External";
        if (!id || !raw || out.has(id)) continue;
        const target = external ? raw : partPath(path, raw);
        if (target !== undefined)
          out.set(id, { target, external, type: attr(rel, "Type") ?? "" });
      }
    this.relationshipMaps.set(path, out);
    return out;
  }
  picture(path: string, contentType?: string): MediaRef | null {
    this.check();
    const cached = this.pictures.get(path);
    if (cached !== undefined) return cached;
    const bytes = this.parts.get(path);
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
    };
    let mime = contentType;
    const declared = this.contentType(path);
    if (!mime) mime = declared;
    mime ??= types[path.split(".").pop()?.toLowerCase() ?? ""];
    const pixels =
      bytes && this.mediaBytes + bytes.length <= MAX_MEDIA_BYTES
        ? rasterPixels(bytes, mime)
        : undefined;
    // Unknown -> retained ref or omitted null. Only a first successful admission
    // consumes either budget; cached omissions cannot retry after parsing.
    if (
      pixels === undefined ||
      this.mediaPixels + pixels > MAX_PACKAGE_PIXELS
    ) {
      this.pictures.set(path, null);
      return null;
    }
    const ref: MediaRef = `mdv-media:${this.media.size}`;
    this.media.set(
      ref,
      new Blob(
        [required(bytes).slice().buffer],
        mime === undefined ? {} : { type: mime },
      ),
    );
    this.mediaBytes += required(bytes).length;
    this.mediaPixels += pixels;
    this.pictures.set(path, ref);
    return ref;
  }
}
