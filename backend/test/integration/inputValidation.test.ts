import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests as resetContributions } from '../../src/services/contributionService';
import { _resetForTests as resetHazards } from '../../src/services/hazardService';

/**
 * Use case: users (or buggy/tampered clients) send malformed, oversized, or
 * malicious-looking input, and the system rejects it cleanly instead of
 * accepting it, crashing, or letting it corrupt shared state — whether that
 * happens by accident (a bug in a future native client) or on purpose.
 */
describe('Use case: reject malicious or malformed input at the trust boundary', () => {
  const app = createApp();

  beforeEach(() => {
    resetContributions();
    resetHazards();
  });

  const validContributionBody = () => ({
    trailId: SHADOW_CREEK_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    capturedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    imageBase64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 1)]).toString('base64'),
    contributorId: 'hiker-1',
  });

  const validHazardBody = () => ({
    trailId: SHADOW_CREEK_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    hazardType: 'downed_tree',
    severity: 'moderate',
    reportedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    reporterId: 'hiker-1',
  });

  it('accepts a well-formed contribution (sanity check that the fixture itself is valid)', async () => {
    const res = await request(app).post('/contributions/photos').send(validContributionBody());
    expect(res.status).toBe(202);
  });

  it('rejects a path-traversal-style trailId instead of letting it flow into storage-key construction', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), trailId: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details.some((d: string) => d.includes('trailId'))).toBe(true);
  });

  it('rejects an out-of-range location', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), location: { lat: 999, lng: -119.5 } });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('location'))).toBe(true);
  });

  it('rejects a timestamp far outside the plausible window', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), capturedAt: '1970-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('capturedAt'))).toBe(true);
  });

  it('rejects a description/contributorId containing control characters', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), contributorId: 'hiker-1\u0000-null-byte' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('contributorId'))).toBe(true);
  });

  it('rejects imageBase64 that is not validly-charset base64', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), imageBase64: '!!!not-base64 at all!!!' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('imageBase64'))).toBe(true);
  });

  it('rejects base64 content that decodes fine but is not a recognized image format', async () => {
    const notAnImage = Buffer.from('this is just plain text, not a photo').toString('base64');
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), imageBase64: notAnImage });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('imageBase64'))).toBe(true);
  });

  it('rejects a decoded image larger than the 8MB cap', async () => {
    // ~8.5MB decoded (comfortably over the 8MB cap, comfortably under the
    // 15MB request body limit once base64-encoded).
    const oversized = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(8.5 * 1024 * 1024, 1),
    ]).toString('base64');
    const res = await request(app)
      .post('/contributions/photos')
      .send({ ...validContributionBody(), imageBase64: oversized });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('imageBase64'))).toBe(true);
  }, 20000);

  it('accepts a well-formed hazard report (sanity check)', async () => {
    const res = await request(app).post('/hazards/reports').send(validHazardBody());
    expect(res.status).toBe(202);
  });

  it('rejects an unrecognized hazardType instead of silently storing it', async () => {
    const res = await request(app)
      .post('/hazards/reports')
      .send({ ...validHazardBody(), hazardType: 'godzilla_attack' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('hazardType'))).toBe(true);
  });

  it('rejects an unrecognized severity value', async () => {
    const res = await request(app)
      .post('/hazards/reports')
      .send({ ...validHazardBody(), severity: 'extremely-bad' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('severity'))).toBe(true);
  });

  it('rejects an oversized description', async () => {
    const res = await request(app)
      .post('/hazards/reports')
      .send({ ...validHazardBody(), description: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: string) => d.includes('description'))).toBe(true);
  });

  it('handles a malformed JSON body as a clean 400, not a crash', async () => {
    const res = await request(app)
      .post('/contributions/photos')
      .set('Content-Type', 'application/json')
      .send('{this is not valid json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json_body');
  });

  it('caps how many pending contributions a single contributor can queue per trail', async () => {
    // All from the same contributor, so corroboration (which needs 2+
    // distinct contributors) never fires and the cap is what's actually
    // being tested here, not the promotion pipeline.
    for (let i = 0; i < 20; i++) {
      const res = await request(app).post('/contributions/photos').send(validContributionBody());
      expect(res.status).toBe(202);
    }
    const blocked = await request(app).post('/contributions/photos').send(validContributionBody());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_pending_contributions');
  });
});
