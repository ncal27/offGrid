import request from 'supertest';
import { createApp } from '../../src/app';
import { makeImageBase64 } from '../helpers/images';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests as resetContributions, listPendingForTrail } from '../../src/services/contributionService';
import { _resetForTests as resetLandmarkPhotos } from '../../src/services/landmarkPhotoService';

/**
 * Use case: crowdsourced landmark photos start as unverified contributions
 * and either get promoted automatically once enough independent hikers
 * corroborate the same spot, or get promoted/rejected by a human reviewer.
 * Either way, nothing ships in a trip package until promotion happens.
 */
const REVIEWER_TOKEN = 'test-reviewer-token-0123456789abcdef0123456789';

describe('Use case: crowdsourced photos get promoted into the official dataset', () => {
  const app = createApp({ writeRateLimit: false });
  const auth = { Authorization: `Bearer ${REVIEWER_TOKEN}` };

  beforeAll(() => {
    process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
  });
  afterAll(() => {
    delete process.env.OFFGRID_REVIEWER_TOKEN;
  });

  beforeEach(() => {
    resetContributions();
    resetLandmarkPhotos();
  });

  // Must be a real, decodable image: the upload pipeline decodes and
  // re-encodes every photo (see test/helpers/images.ts).
  let validImageBase64: string;
  beforeAll(async () => {
    validImageBase64 = await makeImageBase64();
  });

  const contribute = (contributorId: string, overrides: Partial<Record<string, unknown>> = {}) =>
    request(app)
      .post('/contributions/photos')
      .send({
        trailId: SHADOW_CREEK_TRAIL_ID,
        waypointHintId: 'scl-wp1',
        capturedAt: new Date().toISOString(),
        gpsWeakOrMissing: false,
        imageBase64: validImageBase64,
        contributorId,
        ...overrides,
      });

  it('leaves a single contribution pending — one hiker is not corroboration', async () => {
    const res = await contribute('hiker-1');
    expect(res.body.status).toBe('pending_review');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);
  });

  it('auto-promotes once a second independent hiker corroborates the same waypoint', async () => {
    const first = await contribute('hiker-1');
    expect(first.body.status).toBe('pending_review');

    const second = await contribute('hiker-2');
    expect(second.body.status).toBe('promoted');

    // Both corroborating contributions are consumed, not left dangling as pending.
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(0);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    const promotedPhoto = pkgRes.body.landmarkPhotos.find((p: { source: string }) => p.source === 'contributed');
    expect(promotedPhoto).toBeDefined();
    expect(promotedPhoto.status).toBe('promoted');
    expect(promotedPhoto.waypointId).toBe('scl-wp1');
  });

  it('does not let the same contributor corroborate against themselves', async () => {
    await contribute('hiker-1');
    const second = await contribute('hiker-1'); // same contributor submitting twice
    expect(second.body.status).toBe('pending_review');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(2);
  });

  it('lets a human reviewer manually promote a still-pending contribution', async () => {
    const submitRes = await contribute('hiker-1');
    const contributionId = submitRes.body.id;

    const promoteRes = await request(app).post(`/contributions/${contributionId}/promote`).set(auth).send({});
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.promoted).toBe(true);
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(0);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    const shippedIds = pkgRes.body.landmarkPhotos.map((p: { id: string }) => p.id);
    expect(shippedIds).toContain(promoteRes.body.photo.id);
  });

  it('lets a human reviewer reject a pending contribution so it never ships', async () => {
    const submitRes = await contribute('hiker-1');
    const contributionId = submitRes.body.id;

    const rejectRes = await request(app).post(`/contributions/${contributionId}/reject`).set(auth);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.rejected).toBe(true);
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(0);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(
      pkgRes.body.landmarkPhotos.some((p: { source: string }) => p.source === 'contributed'),
    ).toBe(false);
  });

  it('404s when promoting or rejecting a contribution that does not exist', async () => {
    const promoteRes = await request(app).post('/contributions/not-a-real-id/promote').set(auth).send({});
    expect(promoteRes.status).toBe(404);

    const rejectRes = await request(app).post('/contributions/not-a-real-id/reject').set(auth);
    expect(rejectRes.status).toBe(404);
  });
});
