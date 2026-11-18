import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests, bumpTrailVersion } from '../../src/services/trailService';

/**
 * Use case: a device that already downloaded a trail wants to know, next
 * time it has signal, whether the official data has moved on without
 * re-fetching the whole trail (waypoints, route line, elevation profile).
 */
describe('Use case: check whether a downloaded trail package is stale', () => {
  const app = createApp();

  beforeEach(() => _resetForTests());

  it('reports the current version for a known trail', async () => {
    const res = await request(app).get(`/trails/${SHADOW_CREEK_TRAIL_ID}/version`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trailId: SHADOW_CREEK_TRAIL_ID, version: 1 });
  });

  it('reflects a version bump once the official data changes', async () => {
    const newVersion = bumpTrailVersion(SHADOW_CREEK_TRAIL_ID);
    expect(newVersion).toBe(2);

    const res = await request(app).get(`/trails/${SHADOW_CREEK_TRAIL_ID}/version`);
    expect(res.body.version).toBe(2);

    // The full trail and any freshly built package should also reflect it.
    const trailRes = await request(app).get(`/trails/${SHADOW_CREEK_TRAIL_ID}`);
    expect(trailRes.body.version).toBe(2);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(pkgRes.body.trailVersion).toBe(2);
  });

  it('404s for an unknown trail', async () => {
    const res = await request(app).get('/trails/not-a-real-trail/version');
    expect(res.status).toBe(404);
  });
});
