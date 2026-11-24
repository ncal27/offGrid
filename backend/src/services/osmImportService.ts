import { isSafeText, isValidLatLng, LatLng, Trail, Waypoint } from '@offgrid/shared';
import { haversineDistanceMeters } from '../geo';

/**
 * Imports a hiking trail from OpenStreetMap by name, for the live class demo
 * ("shout out a trail you like and we'll plan it"). Uses the free Overpass
 * API. OSM data is © OpenStreetMap contributors (ODbL); the app shows that
 * credit.
 *
 * Everything crossing this boundary is untrusted in BOTH directions:
 *  - the user's search text is restricted to a small character set and
 *    escaped before it goes into the Overpass query, so it can't change the
 *    query (no "query injection");
 *  - whatever comes back from Overpass is validated: coordinates must be real
 *    and inside the search area, names must pass isSafeText, and sizes are
 *    capped.
 *
 * What it builds: the named paths' pieces ("ways") stitched end to end into
 * one route line, plus three generated waypoints (trailhead, midway, end).
 * Real landmark waypoints and elevation aren't in this data; see HANDOFF.md.
 */

/** Where the search looks: Wellesley and the surrounding MetroWest area. */
export const IMPORT_BBOX = { south: 42.15, west: -71.55, north: 42.45, east: -71.05 };
const OVERPASS_URL = process.env.OFFGRID_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ELEMENTS = 2_000;
const MAX_ROUTE_POINTS = 400;
const JOIN_TOLERANCE_METERS = 15;
const QUERY_PATTERN = /^[A-Za-z0-9 .'&-]{2,60}$/;

export interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
export type OverpassFetcher = (query: string) => Promise<{ elements?: unknown }>;

const defaultFetcher: OverpassFetcher = async (query) => {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    headers: { 'User-Agent': 'OffGrid-student-project/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return (await res.json()) as { elements?: unknown };
};
let fetcher: OverpassFetcher = defaultFetcher;

/** Test-only: replace the network call with canned Overpass responses. */
export function _setOverpassFetcherForTests(f: OverpassFetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

/** Returns the cleaned search text, or null if it isn't an acceptable trail name. */
export function sanitizeTrailQuery(raw: unknown): string | null {
  if (!isSafeText(raw, 60)) return null;
  const q = raw.trim().replace(/\s+/g, ' ');
  return QUERY_PATTERN.test(q) ? q : null;
}

/** Only [A-Za-z0-9 .'&-] get this far; "." is the one regex special character among them. */
export function buildOverpassQuery(name: string): string {
  const pattern = name.replace(/\./g, '\\\\.');
  const { south, west, north, east } = IMPORT_BBOX;
  return `[out:json][timeout:25];way["highway"~"^(path|footway|track|bridleway|cycleway)$"]["name"~"${pattern}",i](${south},${west},${north},${east});out geom;`;
}

const inArea = (p: LatLng) =>
  p.lat >= IMPORT_BBOX.south - 0.05 &&
  p.lat <= IMPORT_BBOX.north + 0.05 &&
  p.lng >= IMPORT_BBOX.west - 0.05 &&
  p.lng <= IMPORT_BBOX.east + 0.05;

function pathLength(points: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineDistanceMeters(points[i - 1], points[i]);
  return d;
}

/**
 * Joins way pieces that share endpoints into the longest continuous line.
 * Greedy: start from the longest piece, keep attaching any piece whose end
 * touches either end of the chain (flipping it if needed).
 */
export function stitchWays(pieces: LatLng[][]): LatLng[] {
  const remaining = pieces.filter((p) => p.length >= 2).sort((a, b) => pathLength(b) - pathLength(a));
  if (remaining.length === 0) return [];
  let best: LatLng[] = [];
  while (remaining.length) {
    let chain = [...remaining.shift()!];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        const near = (a: LatLng, b: LatLng) => haversineDistanceMeters(a, b) <= JOIN_TOLERANCE_METERS;
        const head = chain[0];
        const tail = chain[chain.length - 1];
        let joined: LatLng[] | null = null;
        if (near(tail, p[0])) joined = [...chain, ...p.slice(1)];
        else if (near(tail, p[p.length - 1])) joined = [...chain, ...[...p].reverse().slice(1)];
        else if (near(head, p[p.length - 1])) joined = [...p.slice(0, -1), ...chain];
        else if (near(head, p[0])) joined = [...[...p].reverse().slice(0, -1), ...chain];
        if (joined) {
          chain = joined;
          remaining.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (pathLength(chain) > pathLength(best)) best = chain;
  }
  return best;
}

function simplify(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

function pointAtDistance(points: LatLng[], target: number): LatLng {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversineDistanceMeters(points[i - 1], points[i]);
    if (d + seg >= target) return points[i];
    d += seg;
  }
  return points[points.length - 1];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/** Turns an Overpass response into a Trail, or null if nothing usable matched. */
export function trailFromOverpass(query: string, response: { elements?: unknown }): Trail | null {
  if (!Array.isArray(response.elements)) return null;
  const ways = (response.elements as OverpassWay[]).slice(0, MAX_ELEMENTS).filter((e) => e && e.type === 'way');

  // Group pieces by their (validated) name; the name with the most trail wins.
  const byName = new Map<string, LatLng[][]>();
  for (const w of ways) {
    const name = w.tags?.name;
    if (!isSafeText(name, 100) || !Array.isArray(w.geometry)) continue;
    const pts = w.geometry
      .map((g) => ({ lat: Number(g?.lat), lng: Number(g?.lon) }))
      .filter((p) => isValidLatLng(p) && inArea(p));
    if (pts.length < 2) continue;
    byName.set(name.trim(), [...(byName.get(name.trim()) ?? []), pts]);
  }
  let bestName = '';
  let bestRoute: LatLng[] = [];
  for (const [name, pieces] of byName) {
    const route = stitchWays(pieces);
    if (pathLength(route) > pathLength(bestRoute)) {
      bestName = name;
      bestRoute = route;
    }
  }
  if (bestRoute.length < 2) return null;

  const routeLine = simplify(bestRoute, MAX_ROUTE_POINTS);
  const distance = Math.round(pathLength(routeLine));
  const id = `osm-${slug(bestName) || slug(query)}`;
  const isLoop = haversineDistanceMeters(routeLine[0], routeLine[routeLine.length - 1]) < 50;
  const marks: { name: string; at: number }[] = [
    { name: 'Trailhead', at: 0 },
    { name: 'Midway', at: distance / 2 },
    ...(isLoop ? [] : [{ name: 'Trail end', at: distance }]),
  ];
  const waypoints: Waypoint[] = marks.map((m, i) => ({
    id: `${id}-wp${i + 1}`,
    trailId: id,
    name: m.name,
    location: m.at === 0 ? routeLine[0] : pointAtDistance(routeLine, m.at),
    distanceFromStartMeters: Math.round(m.at),
  }));

  return {
    id,
    name: bestName,
    region: 'US-MA',
    distanceMeters: distance,
    elevationGainMeters: 0, // not in OSM path data; see HANDOFF.md
    dataSource: 'openstreetmap',
    routeLine,
    waypoints,
    elevationProfile: [],
    version: 1,
  };
}

export type ImportResult =
  | { ok: true; trail: Trail }
  | { ok: false; reason: 'invalid_query' | 'not_found' | 'upstream_error' };

export async function importTrailByName(rawQuery: unknown): Promise<ImportResult> {
  const query = sanitizeTrailQuery(rawQuery);
  if (!query) return { ok: false, reason: 'invalid_query' };
  let response: { elements?: unknown };
  try {
    response = await fetcher(buildOverpassQuery(query));
  } catch {
    return { ok: false, reason: 'upstream_error' };
  }
  const trail = trailFromOverpass(query, response ?? {});
  return trail ? { ok: true, trail } : { ok: false, reason: 'not_found' };
}
