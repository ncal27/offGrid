/**
 * Builds the Blue Hills (Great Blue Hill) trail and its seasonal reference
 * photos from open data, and writes backend/src/data/blueHills.json.
 *
 *   npm run data:blue-hills        (repo root; needs internet)
 *
 * Sources (both free; credit is kept with the data and shown in the app):
 *  - Trails and landmarks: OpenStreetMap (© OpenStreetMap contributors, ODbL),
 *    one request to the main map API for a small area around the summit.
 *  - Photos: Wikimedia Commons. Only free licences (CC0, CC BY, CC BY-SA,
 *    public domain) and only images on Wikimedia's own hosts (upload./thumb.
 *    wikimedia.org). We store
 *    links and credits, not copies of the images.
 *
 * Re-run occasionally rather than on every start: both services ask for
 * light, identified use.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { isSafeText, LandmarkPhoto, LatLng, Season, seasonOf, Trail, TrailBranch, Waypoint, WaypointKind } from '@offgrid/shared';
import { stitchWays } from '../src/services/osmImportService';
import { haversineDistanceMeters } from '../src/geo';

const TRAIL_ID = 'blue-hills-great-blue-hill';
const BBOX = { west: -71.125, south: 42.205, east: -71.1, north: 42.222 };
const UA = 'OffGrid-student-project/1.0 (class demo)';
const MAX_PHOTOS_PER_PLACE_PER_SEASON = 3;

const LANDMARKS: { osmName: string; name: string; kind: WaypointKind; description: string }[] = [
  { osmName: 'Blue Hills Trailside Museum', name: 'Trailside Museum (trailhead)', kind: 'trailhead', description: 'Parking, restrooms and the usual start for Great Blue Hill.' },
  { osmName: 'Great Blue Hill', name: 'Great Blue Hill summit', kind: 'summit', description: 'Highest point in the reservation (635 ft), with the weather observatory.' },
  { osmName: 'Eliot Tower', name: 'Eliot Tower', kind: 'viewpoint', description: 'Stone lookout tower near the summit with views to Boston.' },
  { osmName: 'Little Blue Hill', name: 'Little Blue Hill', kind: 'summit', description: 'Smaller peak on the Skyline Trail, west of the summit.' },
  { osmName: 'Wolcott Hill', name: 'Wolcott Hill', kind: 'summit', description: 'On the North Skyline Trail, east of the summit.' },
  { osmName: 'Hemenway Hill', name: 'Hemenway Hill', kind: 'summit', description: 'Eastern peak on the North Skyline Trail.' },
  { osmName: 'Breakneck Ledge', name: 'Breakneck Ledge', kind: 'landmark', description: 'Rocky ledge with open views.' },
];

type OsmElement = { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polite fetch: one request per second, and one slower retry if the server says "too many requests". */
async function getJson(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await pause(1000);
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 && attempt === 0) {
      await pause(Number(res.headers.get('retry-after') ?? 10) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * A ~500px version of a Wikimedia image for lists and offline storage.
 * Wikimedia picks the size it actually returns (1280px was seen, or the
 * original file when it's small), so don't assume a size: assuming "1024px"
 * left full-size images as "thumbnails" (BUG-021).
 */
export function thumbnailFor(url: string, originalWidth: number): string {
  if (/\/\d+px-/.test(url)) return url.replace(/\/\d+px-/, '/500px-');
  if (!originalWidth || originalWidth <= 500) return url; // already small
  const m = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f]\/[0-9a-f]{2})\/([^?/]+)/.exec(url);
  return m ? `${m[1]}/thumb/${m[2]}/${m[3]}/500px-${m[3]}` : url;
}

const pathLength = (pts: LatLng[]) => pts.slice(1).reduce((d, p, i) => d + haversineDistanceMeters(pts[i], p), 0);
function simplify(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}
const round = (p: LatLng): LatLng => ({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 });

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const FREE_LICENSE = /^(CC0|CC BY(-SA)? [\d.]+|CC BY(-SA)?|Public domain|PD.*)$/i;
const NOT_A_LANDSCAPE = /iNaturalist|\.(svg|tiff?|pdf|gif)$|map|logo|diagram|chart|plan of/i;

async function buildTrail(): Promise<Trail> {
  const { west, south, east, north } = BBOX;
  const data = await getJson(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${west},${south},${east},${north}`);
  const elements: OsmElement[] = data.elements;
  const nodes = new Map<number, LatLng>();
  for (const e of elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) nodes.set(e.id, { lat: e.lat, lng: e.lon });
  const coords = (w: OsmElement) => (w.nodes ?? []).map((id) => nodes.get(id)).filter((p): p is LatLng => !!p);

  const paths = elements.filter(
    (e) => e.type === 'way' && ['path', 'footway', 'track', 'bridleway'].includes(e.tags?.highway ?? '') && isSafeText(e.tags?.name, 80),
  );
  const byName = new Map<string, LatLng[][]>();
  for (const w of paths) {
    const line = coords(w);
    if (line.length >= 2) byName.set(w.tags!.name, [...(byName.get(w.tags!.name) ?? []), line]);
  }

  // Main route: the Skyline Trail pieces over Great Blue Hill, stitched.
  const skyline = [...byName.entries()].filter(([n]) => /skyline/i.test(n)).flatMap(([, ls]) => ls);
  const routeLine = simplify(stitchWays(skyline), 300).map(round);
  if (routeLine.length < 2) throw new Error('No Skyline Trail found');

  // Every other named path becomes a side trail (one entry per connected piece).
  const branches: TrailBranch[] = [];
  for (const [name, lines] of byName) {
    if (/skyline/i.test(name)) continue;
    let remaining = lines;
    let n = 0;
    while (remaining.length) {
      const chain = stitchWays(remaining);
      remaining = remaining.filter((l) => !l.every((p) => chain.some((c) => c.lat === p.lat && c.lng === p.lng)));
      if (pathLength(chain) >= 60) {
        branches.push({ id: `${TRAIL_ID}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++n}`, name, line: simplify(chain, 120).map(round) });
      }
      if (n > 5) break;
    }
  }

  // Landmarks: OSM nodes, or the centre of a building outline.
  const located = new Map<string, LatLng>();
  for (const e of elements) {
    const name = e.tags?.name;
    if (!name || !LANDMARKS.some((l) => l.osmName === name) || located.has(name)) continue;
    if (e.type === 'node' && e.lat !== undefined) located.set(name, { lat: e.lat, lng: e.lon! });
    if (e.type === 'way') {
      const pts = coords(e);
      if (pts.length) located.set(name, { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length });
    }
  }
  const distanceAlong = (p: LatLng) => {
    let best = 0;
    let bestD = Infinity;
    let along = 0;
    routeLine.forEach((q, i) => {
      if (i) along += haversineDistanceMeters(routeLine[i - 1], q);
      const d = haversineDistanceMeters(p, q);
      if (d < bestD) {
        bestD = d;
        best = along;
      }
    });
    return Math.round(best);
  };
  const waypoints: Waypoint[] = LANDMARKS.filter((l) => located.has(l.osmName))
    .map((l) => ({
      id: `${TRAIL_ID}-${l.osmName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      trailId: TRAIL_ID,
      name: l.name,
      kind: l.kind,
      description: l.description,
      location: round(located.get(l.osmName)!),
      distanceFromStartMeters: distanceAlong(located.get(l.osmName)!),
    }))
    .sort((a, b) => a.distanceFromStartMeters - b.distanceFromStartMeters);

  return {
    id: TRAIL_ID,
    name: 'Blue Hills: Great Blue Hill & Skyline Trail',
    region: 'US-MA',
    distanceMeters: Math.round(pathLength(routeLine)),
    elevationGainMeters: 160, // approx. base (~30 m) to summit (~194 m); OSM paths carry no elevation
    dataSource: 'openstreetmap',
    routeLine,
    branches,
    waypoints,
    elevationProfile: [],
    version: 1,
  };
}

/** Text searches that find photos from other seasons (many have no location). */
const SEARCHES = [
  'Great Blue Hill', 'Great Blue Hill snow', 'Great Blue Hill winter', 'Blue Hills Reservation winter',
  'Blue Hills Reservation summer', 'Blue Hills Reservation spring', 'Eliot Tower Blue Hills', 'Blue Hill Observatory',
  'Blue Hills Trailside Museum', 'Skyline Trail Blue Hills',
];
/** For photos without a location: only place them when the title clearly names the place. */
const TITLE_TO_PLACE: [RegExp, string][] = [
  [/eliot tower/i, 'Eliot Tower'],
  [/observatory|summit|great blue hill/i, 'Great Blue Hill'],
  [/trailside|museum/i, 'Blue Hills Trailside Museum'],
  [/little blue hill/i, 'Little Blue Hill'],
];

async function buildPhotos(trail: Trail): Promise<LandmarkPhoto[]> {
  const api = 'https://commons.wikimedia.org/w/api.php';
  const common = {
    action: 'query', prop: 'imageinfo|coordinates', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '1024',
    iiextmetadatafilter: 'DateTimeOriginal|Artist|LicenseShortName|LicenseUrl|ObjectName', format: 'json',
  };
  const pages = new Map<string, any>();
  const collect = (res: any) => Object.values<any>(res.query?.pages ?? {}).forEach((p) => pages.set(p.title, p));
  for (const wp of trail.waypoints) {
    collect(await getJson(`${api}?${new URLSearchParams({ ...common, generator: 'geosearch', ggscoord: `${wp.location.lat}|${wp.location.lng}`, ggsradius: '400', ggslimit: '50', ggsnamespace: '6' })}`));
  }
  for (const term of SEARCHES) {
    collect(await getJson(`${api}?${new URLSearchParams({ ...common, generator: 'search', gsrsearch: term, gsrnamespace: '6', gsrlimit: '40' })}`));
  }

  const wpByOsmName = new Map(LANDMARKS.map((l) => [l.osmName, trail.waypoints.find((w) => w.id === `${TRAIL_ID}-${l.osmName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)]));
  const photos: (LandmarkPhoto & { _rank: number })[] = [];
  for (const page of pages.values()) {
    if (NOT_A_LANDSCAPE.test(page.title) || /houghton|pond/i.test(page.title)) continue;
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value ?? '');
    const when = new Date(stripHtml(meta.DateTimeOriginal?.value ?? '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    const url: string = info?.thumburl ?? '';
    if (info?.mime !== 'image/jpeg' || !FREE_LICENSE.test(license) || Number.isNaN(when.getTime()) || when.getUTCFullYear() < 1990) continue;
    if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(url)) continue; // only Wikimedia's own image hosts

    // Which place is it? By location if it has one (must be within 600 m), otherwise by title.
    let waypointId: string | undefined;
    let rank = 1000;
    const c = page.coordinates?.[0];
    if (c) {
      let best = Infinity;
      for (const wp of trail.waypoints) {
        const d = haversineDistanceMeters({ lat: c.lat, lng: c.lon }, wp.location);
        if (d < best) [best, waypointId] = [d, wp.id];
      }
      if (best > 600) continue;
      rank = best;
    } else {
      const hit = TITLE_TO_PLACE.find(([re]) => re.test(page.title));
      waypointId = hit ? wpByOsmName.get(hit[1])?.id : undefined;
    }
    if (!waypointId) continue;

    const author = stripHtml(meta.Artist?.value ?? 'Unknown').slice(0, 120) || 'Unknown';
    const title = stripHtml(meta.ObjectName?.value ?? page.title.replace(/^File:|\.\w+$/g, '')).slice(0, 120);
    photos.push({
      id: `commons-${page.pageid}`,
      waypointId,
      trailId: trail.id,
      source: 'official',
      status: 'official',
      capturedAt: when.toISOString(),
      uri: url,
      thumbnailUrl: thumbnailFor(url, info.width),
      season: seasonOf(when),
      title: isSafeText(title, 120) ? title : 'Photo',
      attribution: {
        author: isSafeText(author, 120) ? author : 'Unknown',
        license,
        licenseUrl: /^https:\/\//.test(meta.LicenseUrl?.value ?? '') ? meta.LicenseUrl.value : undefined,
        sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      },
      _rank: rank,
    });
  }
  // Keep the best few per place per season (closest first).
  const kept: LandmarkPhoto[] = [];
  for (const wp of trail.waypoints) {
    for (const season of ['spring', 'summer', 'fall', 'winter'] as Season[]) {
      kept.push(
        ...photos
          .filter((p) => p.waypointId === wp.id && p.season === season)
          .sort((a, b) => a._rank - b._rank)
          .slice(0, MAX_PHOTOS_PER_PLACE_PER_SEASON)
          .map(({ _rank, ...p }) => p),
      );
    }
  }
  return kept;
}

(async () => {
  const trail = await buildTrail();
  console.log(`Trail: ${trail.name}, ${(trail.distanceMeters / 1609).toFixed(2)} mi main route, ${trail.branches!.length} side trails, ${trail.waypoints.length} places`);
  const photos = await buildPhotos(trail);
  const count = (s: Season) => photos.filter((p) => p.season === s).length;
  console.log(`Photos: ${photos.length} (spring ${count('spring')}, summer ${count('summer')}, fall ${count('fall')}, winter ${count('winter')})`);
  for (const wp of trail.waypoints) console.log(`  ${wp.name}: ${photos.filter((p) => p.waypointId === wp.id).length}`);
  const out = join(__dirname, '..', 'src', 'data', 'blueHills.json');
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sources: ['© OpenStreetMap contributors (ODbL)', 'Wikimedia Commons (individual licences per photo)'], trail, photos }, null, 1) + '\n');
  console.log(`Wrote ${out}`);
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
