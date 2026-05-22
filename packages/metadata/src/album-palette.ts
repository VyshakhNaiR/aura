/**
 * Tiny dependency-free dominant-color extractor for album art.
 *
 * Loads the image with CORS, draws it onto a 24×24 canvas, walks the
 * 576 pixels into HSL buckets, returns the top-N most populated buckets
 * as a palette. Coarse but reliable, and runs in ~3 ms.
 */
export interface PaletteColor {
  /** 0..1 normalized linear RGB. */
  r: number;
  g: number;
  b: number;
}

export async function extractPalette(
  url: string,
  size = 24,
): Promise<PaletteColor[]> {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unsupported");
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  // 12 hue × 4 lightness buckets (skip very dark / very light).
  const buckets = new Map<number, { sum: [number, number, number]; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const a = data[i + 3]! / 255;
    if (a < 0.5) continue;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.1) continue; // ignore grey
    if (l < 0.08 || l > 0.92) continue; // ignore near-black / near-white
    const hb = Math.floor(h * 12) % 12;
    const lb = Math.min(3, Math.floor(l * 4));
    const key = hb * 4 + lb;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { sum: [0, 0, 0], n: 0 };
      buckets.set(key, entry);
    }
    entry.sum[0] += r;
    entry.sum[1] += g;
    entry.sum[2] += b;
    entry.n++;
  }

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  return sorted.slice(0, 4).map((e) => ({
    r: e.sum[0] / e.n,
    g: e.sum[1] / e.n,
    b: e.sum[2] / e.n,
  }));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image ${url}`));
    img.src = url;
  });
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}
