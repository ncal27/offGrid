import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';

/**
 * Use case: a hiker plans a trip while they have signal, then downloads
 * everything needed to navigate it later with no wifi/cell connection.
 */
describe('Use case: plan a trip and download it for offline use', () => {
  const app = createApp();

  it('finds the trail while searching online', async () => {
    const res = await request(app).get('/trails/search').query({ q: 'Shadow Creek' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(SHADOW_CREEK_TRAIL_ID);
  });

  it('fetches full trail detail including waypoints and route line for planning', async () => {
    const res = await request(app).get(`/trails/${SHADOW_CREEK_TRAIL_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.waypoints.length).toBeGreaterThan(0);
    expect(res.body.routeLine.length).toBeGreaterThan(1);
  });

  it('builds a downloadable trip package containing only official landmark photos', async () => {
    const res = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(res.status).toBe(200);
    expect(res.body.trailId).toBe(SHADOW_CREEK_TRAIL_ID);
    expect(res.body.trailVersion).toBe(1);
    expect(res.body.mapTiles).toBeDefined();
    expect(res.body.mapTiles.tileFormat).toBe('mbtiles');
    expect(res.body.landmarkPhotos.length).toBeGreaterThan(0);
    for (const photo of res.body.landmarkPhotos) {
      expect(['official', 'promoted']).toContain(photo.status);
    }
  });

  it('404s when planning a trip around a trail that does not exist', async () => {
    const res = await request(app).get('/trails/not-a-real-trail');
    expect(res.status).toBe(404);
  });
});
