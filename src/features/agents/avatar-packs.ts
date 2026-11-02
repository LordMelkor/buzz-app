import catalog from "./avatar-packs/catalog.json";

const posters = import.meta.glob<string>("./avatar-packs/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export const avatarPacks = catalog.collections;
export const agentAvatars = catalog.assets.map((asset) => ({
  ...asset,
  preview: posters[`./avatar-packs/${asset.id}.png`],
}));

/** The bundled copy of pack art, which can be read back from a canvas: the
 * CDN sends no CORS header. */
export const bundledPoster = (src: string) =>
  agentAvatars.find((avatar) => avatar.url === src.split("#", 1)[0])?.preview;

/** Animations stream from the catalog's CDN; the bundled poster covers offline use. */
export function avatarAnimation(id: string) {
  const animations = catalog.assets.find(
    (asset) => asset.id === id,
  )?.animations;
  return { webm: animations?.webm.url, hevc: animations?.hevc.url };
}

export function randomAgentAvatar() {
  const avatar = agentAvatars[Math.floor(Math.random() * agentAvatars.length)];
  if (!avatar) throw new Error("Bundled avatar catalog is empty");
  return avatar;
}
