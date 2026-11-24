import request from 'supertest';
import { createApp } from '../../src/app';
import { BLUE_HILLS_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests as resetHazards } from '../../src/services/hazardService';

/**
 * Use case: a hiker plans Great Blue Hill (Blue Hills Reservation), a real
 * trail network with forks, built from OpenStreetMap, with free-licensed
 * reference photos from Wikimedia Commons that they can browse by season and
 * place. These checks also guard the generated data file if it's regenerated
 * (`npm run data:blue-hills`).
 */
describe('Use case: plan the Blue Hills (Great Blue Hill) hike with seasonal photos', () => {
  const app = createApp({ writeRateLimit: false });
  beforeEach(() => resetHazards());

  const download = async () => (await request(app).post(`/trails/${BLUE_HILLS_TRAIL_ID}/package`)).body;

  it('is listed and downloadable', async () => {
    const found = (await request(app).get('/trails/search?q=blue hills')).body;
    expect(found.map((t: { id: string }) => t.id)).toContain(BLUE_HILLS_TRAIL_ID);
    const pkg = await download();
    expect(pkg.trail.routeLine.length).toBeGreaterThan(10);
  });

  it('includes the side trails (forks), not just one line', async () => {
    const { trail } = await download();
    expect(trail.branches.length).toBeGreaterThanOrEqual(5);
    const names = trail.branches.map((b: { name: string }) => b.name);
    expect(names.some((n: string) => /red dot/i.test(n))).toBe(true);
    for (const b of trail.branches) expect(b.line.length).toBeGreaterThanOrEqual(2);
  });

  it('marks the real landmarks as places: trailhead, summit and Eliot Tower', async () => {
    const { trail } = await download();
    const byKind = (k: string) => trail.waypoints.filter((w: { kind: string }) => w.kind === k).map((w: { name: string }) => w.name);
    expect(byKind('trailhead').join()).toMatch(/Trailside Museum/);
    expect(byKind('summit').join()).toMatch(/Great Blue Hill/);
    expect(byKind('viewpoint').join()).toMatch(/Eliot Tower/);
  });

  it('ships reference photos that are credited, free-licensed, seasonal and tied to a place', async () => {
    const { trail, landmarkPhotos } = await download();
    expect(landmarkPhotos.length).toBeGreaterThan(5);
    const placeIds = new Set(trail.waypoints.map((w: { id: string }) => w.id));
    for (const p of landmarkPhotos) {
      expect(placeIds.has(p.waypointId)).toBe(true);
      expect(['spring', 'summer', 'fall', 'winter']).toContain(p.season);
      expect(p.uri).toMatch(/^https:\/\/(upload|thumb)\.wikimedia\.org\//);
      expect(p.thumbnailUrl).toMatch(/^https:\/\/(upload|thumb)\.wikimedia\.org\//);
      expect(p.attribution.author.length).toBeGreaterThan(0);
      expect(p.attribution.license).toMatch(/^(CC0|CC BY|Public domain|PD)/i);
      expect(p.attribution.sourceUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File/);
    }
  });

  it('ships real thumbnails, smaller than the full photo (Ironhide: BUG-021)', async () => {
    const { landmarkPhotos } = await download();
    for (const p of landmarkPhotos.filter((x: { source: string }) => x.source === 'official')) {
      expect(p.thumbnailUrl).not.toBe(p.uri);
      const px = Number(/\/(\d+)px-/.exec(p.thumbnailUrl)?.[1]);
      expect(px).toBeGreaterThan(0);
      expect(px).toBeLessThanOrEqual(500);
    }
  });

  it('lets hikers report a hazard on a side trail', async () => {
    const { trail } = await download();
    const branchPoint = trail.branches[0].line[Math.floor(trail.branches[0].line.length / 2)];
    const res = await request(app).post('/hazards/reports').send({
      trailId: BLUE_HILLS_TRAIL_ID,
      hazardType: 'downed_tree',
      severity: 'moderate',
      reportedAt: new Date().toISOString(),
      location: branchPoint,
      reporterId: 'hiker-1',
    });
    expect(res.status).toBe(202);
    expect((await download()).hazards).toHaveLength(1);
  });
});
