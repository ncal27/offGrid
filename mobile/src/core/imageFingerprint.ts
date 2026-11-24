import { decode } from 'jpeg-js';

/**
 * Offline "Where am I?" from a photo, with no AI model and no internet.
 *
 * This is a deliberately simple, built-in IMAGE FINGERPRINT, a stand-in for a
 * trained place-recognition model (see docs/architecture.md). It runs as plain
 * TypeScript on phones and in the browser, so it works in Expo Go and fully
 * offline. It combines three cheap descriptors from a 48×48 copy of the photo:
 *   1. colour mix: hue/saturation/brightness histogram (sky, foliage, stone…)
 *   2. layout: where colours sit in a 4×4 grid (sky on top, water below…)
 *   3. edges: gradient directions per region (a tower's verticals vs a horizon)
 * It's good enough to tell Eliot Tower from a pond, not to recognise the same
 * rock from a different angle. To upgrade, implement EmbeddingAdapter with a
 * real model (e.g. MobileNet); rankPlaces() below works with any embedding.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes, row by row. */
  data: Uint8Array;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

/** base64 → bytes without relying on atob/Buffer (works the same everywhere). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64_LOOKUP[clean.charCodeAt(i)];
    const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : -1;
    const d = i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

/** Decodes a JPEG (base64 or data: URI). Size limits guard against huge or malicious files. */
export function decodeJpeg(base64OrDataUri: string): RgbaImage {
  const img = decode(base64ToBytes(base64OrDataUri), {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 40,
    maxMemoryUsageInMB: 256,
  });
  return { width: img.width, height: img.height, data: img.data as Uint8Array };
}

const SIZE = 48;

/** Box-average down to SIZE×SIZE RGB floats (0..1). */
function shrink(img: RgbaImage): Float32Array {
  const out = new Float32Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    const y0 = Math.floor((y * img.height) / SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / SIZE));
    for (let x = 0; x < SIZE; x++) {
      const x0 = Math.floor((x * img.width) / SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / SIZE));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      // Sample at most ~8×8 pixels per cell so big photos stay fast on phones.
      const sy = Math.max(1, Math.floor((y1 - y0) / 8));
      const sx = Math.max(1, Math.floor((x1 - x0) / 8));
      for (let yy = y0; yy < y1; yy += sy) {
        for (let xx = x0; xx < x1; xx += sx) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * SIZE + x) * 3;
      out[o] = r / n / 255;
      out[o + 1] = g / n / 255;
      out[o + 2] = b / n / 255;
    }
  }
  return out;
}

function l2normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** The fingerprint vector (unit length, compare with cosine similarity). */
export function fingerprint(img: RgbaImage): number[] {
  const px = shrink(img);
  const N = SIZE * SIZE;

  // 1. Colour mix: 8 hues × 3 saturations × 3 brightness levels.
  const hist = new Array(72).fill(0);
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = px[i * 3];
    const g = px[i * 3 + 1];
    const b = px[i * 3 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const s = max > 0 ? d / max : 0;
    const hb = Math.min(7, Math.floor((h / 6) * 8));
    const sb = Math.min(2, Math.floor(s * 3));
    const vb = Math.min(2, Math.floor(max * 3));
    hist[hb * 9 + sb * 3 + vb] += 1;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const colour = l2normalize(hist.map((c) => Math.sqrt(c / N))); // sqrt = gentler on dominant colours

  // 2. Layout: mean colour per 4×4 cell, relative to the whole-image mean.
  const mean = [0, 1, 2].map((c) => px.reduce((s, v, i) => (i % 3 === c ? s + v : s), 0) / N);
  const layout: number[] = [];
  const cell = SIZE / 4;
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const acc = [0, 0, 0];
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          for (let c = 0; c < 3; c++) acc[c] += px[(y * SIZE + x) * 3 + c];
        }
      }
      for (let c = 0; c < 3; c++) layout.push(acc[c] / (cell * cell) - mean[c]);
    }
  }

  // 3. Edges: gradient-direction histogram (8 directions) per 4×4 cell.
  const edges = new Array(4 * 4 * 8).fill(0);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const gx = gray[y * SIZE + x + 1] - gray[y * SIZE + x - 1];
      const gy = gray[(y + 1) * SIZE + x] - gray[(y - 1) * SIZE + x];
      const mag = Math.hypot(gx, gy);
      if (mag < 0.02) continue;
      const angle = (Math.atan2(gy, gx) + Math.PI) % Math.PI; // direction, ignoring sign
      const bin = Math.min(7, Math.floor((angle / Math.PI) * 8));
      const cellIdx = Math.min(3, Math.floor(y / cell)) * 4 + Math.min(3, Math.floor(x / cell));
      edges[cellIdx * 8 + bin] += mag;
    }
  }

  return l2normalize([...colour, ...l2normalize(layout).map((v) => v * 0.8), ...l2normalize(edges)]);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface ReferenceEmbedding {
  placeId: string;
  photoId: string;
  embedding: number[];
}

export interface PlaceGuess {
  placeId: string;
  /** Average best similarity across the query photos (0..1). */
  similarity: number;
  /**
   * Share of belief for this place. Places sum to at most 1; the remainder is
   * "none of these / can't tell" (see `unknownBaseline`).
   */
  confidence: number;
  /** The reference photo that matched best (to show "it looks like this"). */
  bestPhotoId: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export const HIGH_CONFIDENCE = 0.6;
export const MEDIUM_CONFIDENCE = 0.4;
export const confidenceLevel = (c: number): ConfidenceLevel =>
  c >= HIGH_CONFIDENCE ? 'high' : c >= MEDIUM_CONFIDENCE ? 'medium' : 'low';

/**
 * Ranks places for one or more query photos. Each place scores its best
 * matching reference photo per query; scores are averaged over the queries
 * (so a series of photos firms up the guess), then turned into confidences
 * with a softmax. `sharpness` controls how decisively small similarity gaps
 * become confidence. `unknownBaseline` is a "none of these" option: without
 * it a featureless photo (fog, a thumb over the lens) would still be called
 * confidently for whichever place it was least unlike. Calibrated for the
 * fingerprint above: real re-shots score ~0.8-0.95, unrelated scenes < 0.35.
 */
export function rankPlaces(
  queries: number[][],
  refs: ReferenceEmbedding[],
  { sharpness = 40, unknownBaseline = 0.5 }: { sharpness?: number; unknownBaseline?: number } = {},
): PlaceGuess[] {
  const places = [...new Set(refs.map((r) => r.placeId))];
  if (queries.length === 0 || places.length === 0) return [];
  const scored = places.map((placeId) => {
    const mine = refs.filter((r) => r.placeId === placeId);
    let total = 0;
    let bestPhotoId = mine[0].photoId;
    let bestSim = -Infinity;
    for (const q of queries) {
      let best = -Infinity;
      for (const r of mine) {
        const s = cosine(q, r.embedding);
        if (s > best) best = s;
        if (s > bestSim) [bestSim, bestPhotoId] = [s, r.photoId];
      }
      total += best;
    }
    return { placeId, similarity: total / queries.length, bestPhotoId };
  });
  const top = Math.max(unknownBaseline, ...scored.map((s) => s.similarity));
  const weights = scored.map((s) => Math.exp((s.similarity - top) * sharpness));
  const sum = weights.reduce((a, b) => a + b, 0) + Math.exp((unknownBaseline - top) * sharpness);
  return scored
    .map((s, i) => ({ ...s, confidence: weights[i] / sum }))
    .sort((a, b) => b.confidence - a.confidence);
}
