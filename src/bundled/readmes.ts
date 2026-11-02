// Each bundled plugin's README.md, keyed by manifest id. Settings → Plugins
// renders it in the plugin's details: user-facing copy first, then any specs.
const manifests = import.meta.glob<{ id: string }>("./*/manifest.json", {
  eager: true,
  import: "default",
});
const readmes = import.meta.glob<string>("./*/README.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const bundledReadmes: ReadonlyMap<string, string> = new Map(
  Object.entries(readmes).flatMap(([path, text]) => {
    const manifest = manifests[path.replace(/README\.md$/, "manifest.json")];
    return manifest ? [[manifest.id, text] as const] : [];
  }),
);
