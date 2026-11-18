import request from 'supertest';
import { createApp } from '../../src/app';
import { makeImageBase64 } from '../helpers/images';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests, listPendingForTrail } from '../../src/services/contributionService';

/**
 * Use case: a hiker tags a landmark photo in the field, it queues locally
 * (mobile side, see mobile tests), and once the device reconnects it gets
 * uploaded here. Per the "official sources first, crowdsourced aggregated
 * later" design decision, a freshly contributed photo must never show up in
 * a trip package until it's been promoted.
 */
describe('Use case: hiker contributes a landmark photo and reconnects later', () => {
  const app = createApp();

  // Must be a real, decodable image: the upload pipeline decodes and
  // re-encodes every photo (see test/helpers/images.ts).
  let validImageBase64: string;
  beforeAll(async () => {
    validImageBase64 = await makeImageBase64();
  });

  beforeEach(() => _resetForTests());

  it('accepts an uploaded contribution as pending review, not yet official', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({
        trailId: SHADOW_CREEK_TRAIL_ID,
        waypointHintId: 'scl-wp1',
        capturedAt: new Date().toISOString(),
        gpsWeakOrMissing: true,
        imageBase64: validImageBase64,
        contributorId: 'hiker-42',
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_review');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);
  });

  it('rejects an upload missing required fields', async () => {
    const res = await request(app).post('/contributions/photos').send({ trailId: SHADOW_CREEK_TRAIL_ID });
    expect(res.status).toBe(400);
  });

  it('never ships a pending contribution inside the next package download', async () => {
    await request(app)
      .post('/contributions/photos')
      .send({
        trailId: SHADOW_CREEK_TRAIL_ID,
        capturedAt: new Date().toISOString(),
        gpsWeakOrMissing: false,
        imageBase64: validImageBase64,
        contributorId: 'hiker-7',
      });

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    const contributedIds = listPendingForTrail(SHADOW_CREEK_TRAIL_ID).map((c) => c.id);
    const shippedIds = pkgRes.body.landmarkPhotos.map((p: { id: string }) => p.id);

    expect(contributedIds.length).toBeGreaterThan(0);
    for (const id of contributedIds) {
      expect(shippedIds).not.toContain(id);
    }
  });
});
