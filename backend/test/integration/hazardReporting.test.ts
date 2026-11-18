import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { _resetForTests as resetHazards, listPendingForTrail } from '../../src/services/hazardService';

/**
 * Use case: a hiker reports a trail hazard (downed tree, washed-out
 * crossing, etc.) in the field with no signal, it syncs once they
 * reconnect, and it only shows up for other hikers downloading the trail
 * once it's been verified — except for 'impassable' reports, which are
 * surfaced immediately given the asymmetric cost of a missed warning.
 */
describe('Use case: report and verify a trail hazard', () => {
  const app = createApp();

  beforeEach(() => resetHazards());

  const report = (reporterId: string, overrides: Partial<Record<string, unknown>> = {}) =>
    request(app)
      .post('/hazards/reports')
      .send({
        trailId: SHADOW_CREEK_TRAIL_ID,
        waypointHintId: 'scl-wp1',
        hazardType: 'downed_tree',
        severity: 'moderate',
        description: 'Large fallen tree blocking the trail, passable with care.',
        reportedAt: new Date().toISOString(),
        gpsWeakOrMissing: false,
        reporterId,
        ...overrides,
      });

  it('leaves a single moderate-severity report pending review', async () => {
    const res = await report('hiker-1');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_review');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(pkgRes.body.hazards).toHaveLength(0);
  });

  it('verifies a hazard once a second independent hiker corroborates the same spot and type', async () => {
    const first = await report('hiker-1');
    expect(first.body.status).toBe('pending_review');

    const second = await report('hiker-2');
    expect(second.body.status).toBe('verified');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(0);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(pkgRes.body.hazards).toHaveLength(1);
    expect(pkgRes.body.hazards[0].hazardType).toBe('downed_tree');
    expect(pkgRes.body.hazards[0].waypointId).toBe('scl-wp1');
  });

  it('verifies an impassable report immediately from a single report', async () => {
    const res = await report('hiker-1', { severity: 'impassable', hazardType: 'bridge_out' });
    expect(res.body.status).toBe('verified');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(0);

    const pkgRes = await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);
    expect(pkgRes.body.hazards).toHaveLength(1);
    expect(pkgRes.body.hazards[0].severity).toBe('impassable');
  });

  it('does not corroborate across different hazard types at the same spot', async () => {
    await report('hiker-1', { hazardType: 'downed_tree' });
    const second = await report('hiker-2', { hazardType: 'flooding' });
    // Different hazardType, so this does not count as corroborating the first report.
    expect(second.body.status).toBe('pending_review');
    expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(2);
  });

  it('rejects a report missing required fields', async () => {
    const res = await request(app).post('/hazards/reports').send({ trailId: SHADOW_CREEK_TRAIL_ID });
    expect(res.status).toBe(400);
  });
});
