// Decorative colors come from the avatar artwork, with a theme fallback for unreadable images.
import { useEffect, useState } from "react";
import { bundledPoster } from "../../agents/avatar-packs";

const bundled = (src: string) => bundledPoster(src) ?? src;

function samplePalette(src: string): Promise<string[]> {
  const result = new Promise<string[]>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onerror = () => resolve([]);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          resolve([]);
          return;
        }
        context.drawImage(image, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        const buckets = new Map<
          string,
          { r: number; g: number; b: number; count: number }
        >();
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i] ?? 0,
            g = pixels[i + 1] ?? 0,
            b = pixels[i + 2] ?? 0;
          // Ignore transparency, white outlines, and near-black contour pixels.
          if (
            (pixels[i + 3] ?? 0) < 192 ||
            Math.min(r, g, b) > 235 ||
            Math.max(r, g, b) < 24
          )
            continue;
          const key = `${r >> 5}:${g >> 5}:${b >> 5}`;
          const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          bucket.count++;
          buckets.set(key, bucket);
        }
        const candidates = [...buckets.values()]
          .map((bucket) => {
            const rgb = [bucket.r, bucket.g, bucket.b].map((value) =>
              Math.round(value / bucket.count),
            );
            const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
            return { rgb, weight: bucket.count * (0.35 + chroma) };
          })
          .sort((a, b) => b.weight - a.weight);
        const chosen: number[][] = [];
        for (const candidate of candidates) {
          // Keep distinct color families rather than three adjacent orange bins.
          if (
            chosen.every(
              (rgb) =>
                rgb.reduce(
                  (sum, value, i) =>
                    sum + (value - (candidate.rgb[i] ?? value)) ** 2,
                  0,
                ) >
                75 ** 2,
            )
          )
            chosen.push(candidate.rgb);
          if (chosen.length === 3) break;
        }
        // Normalize in OKLCH before either shader sees the palette. Keep image
        // hues, lift dark pigments, and avoid turning charcoal into muddy brown.
        // Near-neutral samples inherit the dominant hue because their hue is unstable.
        resolve(
          chosen.map((rgb, index) => {
            const source =
              Math.max(...rgb) - Math.min(...rgb) < 24
                ? (chosen[0] ?? rgb)
                : rgb;
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = `oklch(from rgb(${source.join(", ")}) clamp(${[0.74, 0.8, 0.84][index]}, l, .86) clamp(.16, calc(c * 1.2), .23) h)`;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return `rgb(${r}, ${g}, ${b})`;
          }),
        );
      } catch {
        // An unreadable image leaves the theme palette available.
        resolve([]);
      }
    };
    image.src = bundled(src);
  });
  return result;
}

export function useAvatarPalette(src: string | undefined) {
  const [result, setResult] = useState<{ src: string; colors: string[] }>();
  useEffect(() => {
    if (!src) return;
    let active = true;
    void samplePalette(src).then((colors) => {
      if (active) setResult({ src, colors });
    });
    return () => {
      active = false;
    };
  }, [src]);
  return result && result.src === src ? result.colors : [];
}
