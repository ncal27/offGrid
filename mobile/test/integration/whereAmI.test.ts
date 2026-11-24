import { encode } from 'jpeg-js';
import {
  confidenceLevel,
  decodeJpeg,
  fingerprint,
  rankPlaces,
  ReferenceEmbedding,
} from '../../src/core';

/**
 * Use case: with no signal, a hiker takes a photo and asks "Where am I?". The
 * phone compares it with the trail's downloaded reference photos (all on the
 * device) and answers with a best guess and a confidence, asking for another
 * photo when unsure. Scenes are synthetic JPEGs standing in for real photos.
 */
type Painter = (x: number, y: number, w: number, h: number) => [number, number, number];

function jpeg(paint: Painter, w = 160, h = 120, quality = 80): string {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y, w, h);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return encode({ data, width: w, height: h }, quality).data.toString('base64');
}

const noise = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) % 17;
// Stone tower against blue sky.
const tower: Painter = (x, y, w, h) =>
  x > w * 0.38 && x < w * 0.62 && y > h * 0.15 ? [120 + noise(x, y), 115, 108] : y > h * 0.85 ? [70, 110, 50] : [110, 160, 225];
// Pond: trees on top, water below.
const pond: Painter = (x, y, _w, h) => (y < h * 0.45 ? [50 + noise(x, y), 105, 40] : [60, 90, 120 + (y % 7)]);
// Forest: green with brown vertical trunks.
const forest: Painter = (x, y) => (x % 23 < 5 ? [95, 65, 40] : [40 + noise(x, y), 95, 35]);
const brighter = (p: Painter, d: number): Painter => (x, y, w, h) => p(x, y, w, h).map((c) => Math.min(255, c + d)) as [number, number, number];
const cropped = (p: Painter, f: number): Painter => (x, y, w, h) => p(x * f + (w * (1 - f)) / 2, y * f + (h * (1 - f)) / 2, w, h);

const fp = (p: Painter) => fingerprint(decodeJpeg(jpeg(p)));
const refs: ReferenceEmbedding[] = [
  { placeId: 'eliot-tower', photoId: 'ref-tower', embedding: fp(tower) },
  { placeId: 'pond', photoId: 'ref-pond', embedding: fp(pond) },
  { placeId: 'woods', photoId: 'ref-forest', embedding: fp(forest) },
];

describe('Use case: "Where am I?" from a photo, fully offline', () => {
  it('recognises the place in a re-taken photo (brighter, framed differently)', () => {
    const [best, second] = rankPlaces([fp(cropped(brighter(tower, 18), 0.85))], refs);
    expect(best.placeId).toBe('eliot-tower');
    expect(best.bestPhotoId).toBe('ref-tower');
    expect(best.confidence).toBeGreaterThan(second.confidence);
  });

  it('tells each reference scene apart', () => {
    expect(rankPlaces([fp(cropped(pond, 0.9))], refs)[0].placeId).toBe('pond');
    expect(rankPlaces([fp(cropped(forest, 0.9))], refs)[0].placeId).toBe('woods');
  });

  it('gives an identical photo high confidence', () => {
    const [best] = rankPlaces([fp(tower)], refs);
    expect(best.placeId).toBe('eliot-tower');
    expect(confidenceLevel(best.confidence)).toBe('high');
  });

  it('is unsure about an ambiguous photo, so the app can ask for another', () => {
    const fog: Painter = (x, y) => [150 + (noise(x, y) % 3), 150, 150];
    const [best] = rankPlaces([fp(fog)], refs);
    expect(confidenceLevel(best.confidence)).not.toBe('high');
  });

  it('gets more confident with a series of photos of the same place', () => {
    const one = rankPlaces([fp(cropped(tower, 0.75))], refs)[0];
    const two = rankPlaces([fp(cropped(tower, 0.75)), fp(brighter(tower, 10))], refs)[0];
    expect(two.placeId).toBe('eliot-tower');
    expect(two.confidence).toBeGreaterThanOrEqual(one.confidence);
  });

  it('keeps place confidences at most 1, the rest meaning "can\'t tell"', () => {
    const clear = rankPlaces([fp(pond)], refs).reduce((s, g) => s + g.confidence, 0);
    expect(clear).toBeLessThanOrEqual(1);
    expect(clear).toBeGreaterThan(0.95);
    const fog: Painter = (x, y) => [150 + (noise(x, y) % 3), 150, 150];
    expect(rankPlaces([fp(fog)], refs).reduce((s, g) => s + g.confidence, 0)).toBeLessThan(0.5);
  });

  it('refuses something that is not a JPEG instead of crashing later', () => {
    expect(() => decodeJpeg(Buffer.from('definitely not a jpeg').toString('base64'))).toThrow();
  });
});
