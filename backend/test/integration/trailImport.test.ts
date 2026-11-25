import request from 'supertest';
import { createApp } from '../../src/app';
import { _resetForTests as resetTrails, MAX_IMPORTED_TRAILS } from '../../src/services/trailService';
import { _resetForTests as resetHazards } from '../../src/services/hazardService';
import {
  _setGeocoderForTests,
  _setOverpassFetcherForTests,
  buildOverpassQuery,
  MAX_SEARCH_SPAN,
  IMPORT_BBOX,
  OverpassWay,
  stitchWays,
} from '../../src/services/osmImportService';

/**
 * Use case: in the live class demo, someone shouts out a local trail, we type
 * it in, and OffGrid pulls it from OpenStreetMap so we can plan and download
 * the hike. The Overpass API is replaced with canned, OSM-shaped responses.
 */

// A ~450m trail near Rocky Ledges, Wellesley, in two pieces: the second piece
// is stored in the opposite direction (common in OSM), so it must be flipped
// when stitched.
const way = (id: number, name: string, pts: [number, number][]): OverpassWay => ({
  type: 'way',
  id,
  tags: { highway: 'path', name },
  geometry: pts.map(([lat, lon]) => ({ lat, lon })),
});
const ROCKY_LEDGES = {
  elements: [
    way(1, 'Rocky Ledges Trail', [[42.31, -71.3], [42.311, -71.3], [42.312, -71.3]]),
    way(2, 'Rocky Ledges Trail', [[42.314, -71.3], [42.313, -71.3], [42.312, -71.3]]),
    way(3, 'Rocky Ledges Spur', [[42.312, -71.3], [42.312, -71.2995]]),
    way(4, 'Rocky Ledges Trail', [[95, -71.3], [42.31, 500]]), // invalid coordinates, ignored
    way(5, 'Rocky Ledges Trail', [[40.0, -75.0], [40.001, -75.0]]), // far outside the area, ignored
  ],
};

describe('Use case: add a trail the class shouts out, live from OpenStreetMap', () => {
  const app = createApp({ writeRateLimit: false });
  let calls: string[];

  beforeEach(() => {
    resetTrails();
    resetHazards();
    calls = [];
    _setOverpassFetcherForTests(async (q) => {
      calls.push(q);
      return ROCKY_LEDGES;
    });
  });
  afterAll(() => {
    _setOverpassFetcherForTests(null);
    _setGeocoderForTests(null);
  });

  const importTrail = (query: unknown) => request(app).post('/trails/import').send({ query });

  it('imports a named trail, stitched into one continuous route with trailhead/midway/end waypoints', async () => {
    const res = await importTrail('rocky ledges');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'osm-rocky-ledges-trail', name: 'Rocky Ledges Trail', dataSource: 'openstreetmap', region: 'US-MA' });
    expect(res.body.distanceMeters).toBeGreaterThan(400);
    expect(res.body.distanceMeters).toBeLessThan(500);

    const pkg = (await request(app).post(`/trails/${res.body.id}/package`)).body;
    const lats = pkg.trail.routeLine.map((p: { lat: number }) => p.lat);
    // One continuous direction, no doubling back: the reversed piece was
    // flipped. (OSM doesn't say which end is the "start", so either is fine.)
    const ascending = [...lats].sort((a: number, b: number) => a - b);
    expect([ascending, [...ascending].reverse()]).toContainEqual(lats);
    expect([lats[0], lats[lats.length - 1]].sort()).toEqual([42.31, 42.314]);
    expect(pkg.trail.waypoints.map((w: { name: string }) => w.name)).toEqual(['Trailhead', 'Midway', 'Trail end']);
  });

  it('shows up in search, and hikers can report hazards anywhere along it', async () => {
    await importTrail('rocky ledges');
    const search = (await request(app).get('/trails/search?q=rocky')).body;
    expect(search.map((t: { id: string }) => t.id)).toContain('osm-rocky-ledges-trail');

    const hz = await request(app)
      .post('/hazards/reports')
      .send({
        trailId: 'osm-rocky-ledges-trail',
        hazardType: 'washout',
        severity: 'moderate',
        reportedAt: new Date().toISOString(),
        location: { lat: 42.3125, lng: -71.3 },
        reporterId: 'hiker-1',
      });
    expect(hz.status).toBe(202);
    expect((await request(app).post('/trails/osm-rocky-ledges-trail/package')).body.hazards).toHaveLength(1);
  });

  it('re-importing the same trail returns the existing one', async () => {
    expect((await importTrail('rocky ledges')).status).toBe(201);
    const again = await importTrail('Rocky Ledges');
    expect(again.status).toBe(200);
    expect(again.body.id).toBe('osm-rocky-ledges-trail');
  });

  it('searches only the Wellesley/MetroWest area and only for path-like ways', () => {
    const q = buildOverpassQuery('St. Mary');
    const { south, west, north, east } = IMPORT_BBOX;
    expect(q).toContain(`(${south},${west},${north},${east})`);
    expect(q).toContain('"name"~"St\\\\. Mary",i');
    expect(q).toContain('highway"~"^(path|footway|track|bridleway|cycleway)$"');
  });

  it('refuses search text that could change the OpenStreetMap query, without contacting it', async () => {
    for (const bad of ['"];out;', 'x', 'a'.repeat(61), 'Rocky‮Ledges', '<script>', 'trail(1)', 'a\\b', 42, null]) {
      const res = await importTrail(bad);
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('says clearly when the trail is not found or OpenStreetMap is unavailable', async () => {
    _setOverpassFetcherForTests(async () => ({ elements: [] }));
    expect((await importTrail('Nowhere Path')).body.error).toBe('trail_not_found_in_openstreetmap');

    _setOverpassFetcherForTests(async () => ({ elements: 'garbage' }));
    expect((await importTrail('Nowhere Path')).status).toBe(404);

    _setOverpassFetcherForTests(async () => {
      throw new Error('timeout');
    });
    const res = await importTrail('Nowhere Path');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('openstreetmap_unavailable');
  });

  it(`caps live imports at ${MAX_IMPORTED_TRAILS} trails`, async () => {
    _setOverpassFetcherForTests(async (q) => {
      const name = /"name"~"([^"]+)"/.exec(q)![1];
      return { elements: [way(1, name, [[42.3, -71.3], [42.301, -71.3]])] };
    });
    for (let i = 0; i < MAX_IMPORTED_TRAILS; i++) {
      expect((await importTrail(`Trail ${i}`)).status).toBe(201);
    }
    expect((await importTrail('One Too Many')).status).toBe(507);
  });

  it('stitches pieces whichever way round they are stored', () => {
    const a = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }];
    const b = [{ lat: 0, lng: 0.002 }, { lat: 0, lng: 0.001 }]; // reversed
    const c = [{ lat: 0, lng: -0.001 }, { lat: 0, lng: 0 }];
    expect(stitchWays([a, b, c]).map((p) => p.lng)).toEqual([-0.001, 0, 0.001, 0.002]);
  });

  describe('follow-up: "What town and state is it in?"', () => {
    // Canton, MA roughly; Nominatim returns [south, north, west, east] as strings.
    const CANTON = [{ boundingbox: ['42.12', '42.21', '-71.20', '-71.06'], lat: '42.158', lon: '-71.145' }];
    let geocoded: string[];
    beforeEach(() => {
      geocoded = [];
      _setGeocoderForTests(async (place) => {
        geocoded.push(place);
        return /canton/i.test(place) ? CANTON : /massachusetts$/i.test(place) ? [{ boundingbox: ['41.2', '42.9', '-73.5', '-69.9'] }] : [];
      });
    });

    it('searches around the town the hiker named', async () => {
      // A trail actually in Canton (the Wellesley sample data would be correctly filtered out).
      _setOverpassFetcherForTests(async (q) => {
        calls.push(q);
        return { elements: [way(9, 'Ponkapoag Pond Trail', [[42.165, -71.11], [42.168, -71.105], [42.17, -71.1]])] };
      });
      const res = await request(app).post('/trails/import').send({ query: 'Ponkapoag Pond', near: 'Canton, MA' });
      expect(res.status).toBe(201);
      expect(geocoded).toEqual(['Canton, MA']);
      const bbox = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);out geom/.exec(calls[0])!.slice(1).map(Number);
      expect(bbox[0]).toBeCloseTo(42.09, 2); // south, minus a ~3 km margin
      expect(bbox[3]).toBeCloseTo(-71.03, 2); // east, plus the margin
      expect(res.body.region).toBe('US-MA');
    });

    it('caps a huge area (a whole state) so the search stays small', async () => {
      await request(app).post('/trails/import').send({ query: 'Rocky Ledges', near: 'Massachusetts' });
      const [s, w, n, e] = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);out geom/.exec(calls[0])!.slice(1).map(Number);
      expect(n - s).toBeLessThanOrEqual(MAX_SEARCH_SPAN + 1e-9);
      expect(e - w).toBeLessThanOrEqual(MAX_SEARCH_SPAN + 1e-9);
    });

    it('says when the town itself is not found', async () => {
      const res = await request(app).post('/trails/import').send({ query: 'Rocky Ledges', near: 'Nowheresville, ZZ' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('place_not_found');
      expect(calls).toHaveLength(0);
    });

    it('refuses place text that is not a town name, without contacting anything', async () => {
      for (const near of ['"];out;', '<b>Canton</b>', 'Canton; DROP', 'x'.repeat(80), 42]) {
        expect((await request(app).post('/trails/import').send({ query: 'Rocky Ledges', near })).status).toBe(400);
      }
      expect(geocoded).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });

    it('ignores a geocoder answer with nonsense coordinates', async () => {
      _setGeocoderForTests(async () => [{ boundingbox: ['999', '1000', 'x', '5'] }]);
      expect((await request(app).post('/trails/import').send({ query: 'Rocky Ledges', near: 'Canton, MA' })).body.error).toBe('place_not_found');
    });
  });
});
