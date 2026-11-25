import { isSafeText, isValidLatLng, LatLng, NearbyTrail, TrailDifficulty } from '@offgrid/shared';
import { haversineDistanceMeters } from '../geo';
import { runGeocoder, runOverpass, sanitizeNear, stitchWays, upstreamDetail } from './osmImportService';

/**
 * "Hiking places near <town>": named trails within a radius, with length,
 * distance from the town, ESTIMATED difficulty and estimated time.
 *
 * Difficulty is an estimate: OpenStreetMap paths have no elevation, so it's
 * length-based, nudged up by OSM's own difficulty tags where mappers added
 * them (sac_scale, rocky/scree surfaces, steps, hard-to-see trail).
 * Time assumes ~2 mph (3.2 km/h), slower for harder trails.
 */

export const DEFAULT_RADIUS_MILES = 5;
export const MAX_RADIUS_MILES = 15;
const METERS_PER_MILE = 1609.344;
const MIN_TRAIL_METERS = 400; // ignore short connectors
const MAX_RESULTS = 25;
const MAX_ELEMENTS = 4000;

interface Way {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const SAC_BONUS: Record<string, number> = {
  hiking: 0,
  mountain_hiking: 0.8,
  demanding_mountain_hiking: 1.5,
  alpine_hiking: 2,
  demanding_alpine_hiking: 2.5,
  difficult_alpine_hiking: 3,
};

export function estimateDifficulty(lengthMeters: number, tags: Record<string, string>[]): { score: number; difficulty: TrailDifficulty } {
  let score = Math.min(2.4, lengthMeters / 1000 / 3.5); // ~3.5 km per point of difficulty from length alone
  const has = (key: string, re: RegExp) => tags.some((t) => re.test(t[key] ?? ''));
  score += Math.max(0, ...tags.map((t) => SAC_BONUS[t.sac_scale] ?? 0));
  if (has('surface', /^(rock|scree|stone)$/)) score += 0.4;
  if (has('highway', /^steps$/)) score += 0.3;
  if (has('trail_visibility', /^(bad|horrible|no)$/)) score += 0.3;
  score = Math.round(Math.min(3, score) * 100) / 100;
  return { score, difficulty: score < 1 ? 'easy' : score < 2 ? 'moderate' : 'hard' };
}

export const estimateMinutes = (lengthMeters: number, score: number) =>
  Math.round((lengthMeters / 1000 / 3.2) * 60 * (1 + 0.15 * score));

/** Town centre from a geocoder answer (validated: it's untrusted). */
function centreFromGeocode(result: unknown): LatLng | null {
  const first = Array.isArray(result) ? result[0] : null;
  if (!first) return null;
  const p = { lat: Number(first.lat), lng: Number(first.lon) };
  if (isValidLatLng(p)) return p;
  const bb = Array.isArray(first.boundingbox) ? first.boundingbox.map(Number) : [];
  const mid = { lat: (bb[0] + bb[1]) / 2, lng: (bb[2] + bb[3]) / 2 };
  return bb.length === 4 && isValidLatLng(mid) ? mid : null;
}

export function trailsFromOverpass(response: { elements?: unknown }, centre: LatLng, radiusMeters: number): NearbyTrail[] {
  if (!Array.isArray(response.elements)) return [];
  const byName = new Map<string, { pieces: LatLng[][]; tags: Record<string, string>[] }>();
  for (const w of (response.elements as Way[]).slice(0, MAX_ELEMENTS)) {
    const name = w?.tags?.name;
    if (w?.type !== 'way' || !isSafeText(name, 100) || !Array.isArray(w.geometry)) continue;
    const pts = w.geometry.map((g) => ({ lat: Number(g?.lat), lng: Number(g?.lon) })).filter((p) => isValidLatLng(p));
    if (pts.length < 2) continue;
    const entry = byName.get(name.trim()) ?? { pieces: [], tags: [] };
    entry.pieces.push(pts);
    entry.tags.push(w.tags ?? {});
    byName.set(name.trim(), entry);
  }
  const results: NearbyTrail[] = [];
  for (const [name, { pieces, tags }] of byName) {
    const line = stitchWays(pieces);
    const length = line.slice(1).reduce((d, p, i) => d + haversineDistanceMeters(line[i], p), 0);
    if (length < MIN_TRAIL_METERS) continue;
    const away = Math.min(...line.map((p) => haversineDistanceMeters(centre, p)));
    if (away > radiusMeters * 1.1) continue; // allow for the search's own rounding
    const { score, difficulty } = estimateDifficulty(length, tags);
    results.push({
      name,
      lengthMeters: Math.round(length),
      distanceFromCenterMeters: Math.round(away),
      difficulty,
      difficultyScore: score,
      estimatedMinutes: estimateMinutes(length, score),
      center: line[Math.floor(line.length / 2)],
    });
  }
  return results.sort((a, b) => b.lengthMeters - a.lengthMeters).slice(0, MAX_RESULTS);
}

export type NearbyResult =
  | { ok: true; near: string; radiusMiles: number; results: NearbyTrail[] }
  | { ok: false; reason: 'invalid_near' | 'invalid_radius' | 'place_not_found' | 'upstream_error'; detail?: string };

export async function findNearbyTrails(rawNear: unknown, rawRadius: unknown): Promise<NearbyResult> {
  const near = sanitizeNear(rawNear);
  if (!near) return { ok: false, reason: 'invalid_near' };
  const radiusMiles = rawRadius === undefined || rawRadius === null ? DEFAULT_RADIUS_MILES : Number(rawRadius);
  if (!Number.isFinite(radiusMiles) || radiusMiles < 0.5 || radiusMiles > MAX_RADIUS_MILES) return { ok: false, reason: 'invalid_radius' };
  let centre: LatLng | null;
  try {
    centre = centreFromGeocode(await runGeocoder(near));
  } catch (e) {
    return { ok: false, reason: 'upstream_error', detail: upstreamDetail(e) };
  }
  if (!centre) return { ok: false, reason: 'place_not_found' };
  const radiusMeters = Math.round(radiusMiles * METERS_PER_MILE);
  const query =
    `[out:json][timeout:25];way["highway"~"^(path|footway|track|bridleway|steps)$"]["name"]` +
    `(around:${radiusMeters},${centre.lat.toFixed(5)},${centre.lng.toFixed(5)});out geom;`;
  let response: { elements?: unknown };
  try {
    response = await runOverpass(query);
  } catch (e) {
    return { ok: false, reason: 'upstream_error', detail: upstreamDetail(e) };
  }
  return { ok: true, near, radiusMiles, results: trailsFromOverpass(response ?? {}, centre, radiusMeters) };
}
