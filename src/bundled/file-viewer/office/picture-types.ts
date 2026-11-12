import { attr, descendants } from "./xml";

export const rasterType = (mime: string | undefined) =>
  /^image\/(?:png|jpeg|gif|webp|bmp)$/.test(mime ?? "");
export function pictureTypes(
  doc: Document | undefined,
): (path: string) => string | undefined {
  const overrides = new Map<string, string | undefined>(),
    extensions = new Map<string, string | undefined>();
  if (doc)
    for (const [kind, key, target] of [
      ["Override", "PartName", overrides],
      ["Default", "Extension", extensions],
    ] as const)
      for (const node of descendants(doc, kind)) {
        const value = attr(node, key),
          name = kind === "Default" ? value?.toLowerCase() : value;
        if (name !== undefined && !target.has(name))
          target.set(name, node.getAttribute("ContentType") ?? undefined);
      }
  return (path) =>
    overrides.get(`/${path}`) ??
    extensions.get(path.split(".").pop()?.toLowerCase() ?? "");
}
