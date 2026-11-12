import { css, fontDescriptors } from "./css";

const files = import.meta.glob<string>(
  "/node_modules/katex/dist/fonts/*.woff2",
  {
    eager: true,
    query: "?inline",
    import: "default",
  },
);
// Two states: undefined (Uninstalled), or the current installation lifetime.
let installed: { cleanup: () => void } | undefined;

export function install(): () => void {
  if (installed) return installed.cleanup;
  const style = document.createElement("style");
  style.dataset.plugin = "com.squareup.math";
  style.textContent = css;
  document.head.append(style);
  const fontSet = document.fonts;
  const faces: FontFace[] = [];
  const loads: Promise<FontFace>[] = [];
  let failed = false,
    disposed = false;
  for (const descriptor of fontDescriptors) {
    try {
      const data = Object.entries(files).find(([file]) =>
        file.endsWith(descriptor.file),
      )?.[1];
      if (!data?.startsWith("data:") || !data.includes(";base64,"))
        throw Error("Missing embedded KaTeX font");
      const decoded = atob(data.slice(data.indexOf(",") + 1));
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      const face = new FontFace(descriptor.family, bytes.buffer, {
        style: descriptor.style,
        weight: descriptor.weight,
      });
      fontSet.add(face);
      faces.push(face);
      loads.push(face.load());
    } catch {
      failed = true;
    }
  }
  void Promise.allSettled(loads).then((results) => {
    if (
      !disposed &&
      (failed || results.some((result) => result.status === "rejected"))
    )
      console.warn(
        "Math: some KaTeX fonts could not load; using fallback fonts.",
      );
  });
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    style.remove();
    for (const face of faces) fontSet.delete(face);
    installed = undefined;
  };
  installed = { cleanup };
  return cleanup;
}
