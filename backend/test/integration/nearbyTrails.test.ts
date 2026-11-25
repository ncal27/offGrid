import request from 'supertest';
import { createApp } from '../../src/app';
import { _setGeocoderForTests, _setOverpassFetcherForTests } from '../../src/services/osmImportService';
import { estimateDifficulty, estimateMinutes, MAX_RADIUS_MILES } from '../../src/services/osmNearbyService';

/**
 * Use case: "I'm looking for a hiking place near Needham." The API finds named
 * trails within the radius and returns each one's length, distance from town,
 * estimated difficulty and time, so the app can rank them.
 */
const NEEDHAM = { lat: 42.2809, lng: -71.2378 };
// A straight-ish line of `km` kilometres heading north-east from a start point.
const line = (lat: number, lng: number, km: number) =>
  Array.from({ length: 21 }, (_, i) => ({ lat: lat + (km / 111) * (i / 20) * 0.7, lon: lng + (km / 82) * (i / 20) * 0.7 }));
const way = (name: string, geometry: { lat: number; lon: number }[], tags: Record<string, string> = {}) => ({
  type: 'way',
  tags: { highway: 'path', name, ...tags },
  geometry,
});

const ELEMENTS = [
  way('Noanet Peak Trail', line(42.25, -71.27, 7), { sac_scale: 'mountain_hiking', surface: 'rock' }), // long + rocky
  way('Town Forest Loop', line(42.29, -71.25, 3.2)),
  way('Rosemary Lake Path', line(42.282, -71.236, 1.1)),
  way('Tiny Connector', line(42.281, -71.237, 0.1)), // too short to be a "hiking place"
  way('Far Away Trail', line(42.6, -71.0, 3)), // outside the radius
];

describe('Use case: hiking places near a town, with distance, time and difficulty', () => {
  const app = createApp({ writeRateLimit: false });
  let overpassQueries: string[];

  beforeEach(() => {
    overpassQueries = [];
    _setGeocoderForTests(async (place) => (/needham/i.test(place) ? [{ lat: String(NEEDHAM.lat), lon: String(NEEDHAM.lng) }] : []));
    _setOverpassFetcherForTests(async (q) => {
      overpassQueries.push(q);
      return { elements: ELEMENTS };
    });
  });
  afterAll(() => {
    _setGeocoderForTests(null);
    _setOverpassFetcherForTests(null);
  });

  const nearby = (body: Record<string, unknown>) => request(app).post('/trails/nearby').send(body);

  it('lists named trails within 5 miles of the town by default, with the details needed to rank them', async () => {
    const res = await nearby({ near: 'Needham, MA' });
    expect(res.status).toBe(200);
    expect(res.body.radiusMiles).toBe(5);
    expect(overpassQueries[0]).toContain('(around:8047,42.28090,-71.23780)');
    const names = res.body.results.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Noanet Peak Trail', 'Town Forest Loop', 'Rosemary Lake Path']));
    expect(names).not.toContain('Tiny Connector');
    expect(names).not.toContain('Far Away Trail');
    for (const t of res.body.results) {
      expect(t.lengthMeters).toBeGreaterThan(400);
      expect(t.distanceFromCenterMeters).toBeGreaterThanOrEqual(0);
      expect(['easy', 'moderate', 'hard']).toContain(t.difficulty);
      expect(t.estimatedMinutes).toBeGreaterThan(0);
    }
  });

  it('rates the long rocky mountain-hiking trail hardest and the short lake path easiest', async () => {
    const res = await nearby({ near: 'Needham, MA' });
    const byName = Object.fromEntries(res.body.results.map((t: { name: string; difficulty: string }) => [t.name, t.difficulty]));
    expect(byName['Noanet Peak Trail']).toBe('hard');
    expect(byName['Rosemary Lake Path']).toBe('easy');
  });

  it('estimates difficulty from length plus OpenStreetMap difficulty tags', () => {
    expect(estimateDifficulty(1500, [{}]).difficulty).toBe('easy');
    expect(estimateDifficulty(5000, [{}]).difficulty).toBe('moderate');
    expect(estimateDifficulty(1500, [{ sac_scale: 'demanding_mountain_hiking' }]).difficulty).toBe('moderate');
    expect(estimateDifficulty(9000, [{}]).difficulty).toBe('hard');
    expect(estimateMinutes(3218, 0)).toBe(60); // 2 miles at ~2 mph
    expect(estimateMinutes(3218, 2)).toBeGreaterThan(60); // harder = slower
  });

  it('uses the radius the hiker asked for, within limits', async () => {
    await nearby({ near: 'Needham, MA', radiusMiles: 3 });
    expect(overpassQueries[0]).toContain('around:4828,');
    expect((await nearby({ near: 'Needham, MA', radiusMiles: MAX_RADIUS_MILES + 1 })).body.error).toBe('invalid_radius');
    expect((await nearby({ near: 'Needham, MA', radiusMiles: 'lots' })).body.error).toBe('invalid_radius');
  });

  it('says when the town is not found, and refuses odd place text without contacting anything', async () => {
    expect((await nearby({ near: 'Nowheresville, ZZ' })).body.error).toBe('place_not_found');
    for (const near of ['"];out;', '<b>x</b>', 42, '']) {
      expect((await nearby({ near })).status).toBe(400);
    }
    expect(overpassQueries).toHaveLength(0);
  });

  it('reports OpenStreetMap being unavailable clearly', async () => {
    _setOverpassFetcherForTests(async () => {
      throw new Error('timeout');
    });
    const res = await nearby({ near: 'Needham, MA' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('openstreetmap_unavailable');
  });
});
