import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import {
  _resetForTests as resetHazards,
  getTrust,
  getVerifiedHazardsForTrail,
  HALF_LIFE_HOURS,
  listIncidentsForTrail,
  TRUST_DEFAULT,
} from '../../src/services/hazardService';

/**
 * Use case: Waze-style hazard reporting for hikers. A hazard is shared from
 * the first report, labelled with a confidence tier that rises as more hikers
 * confirm it (very low <3, low 3-<5, medium 5-<10, high 10+), counting an
 * on-the-spot GPS report as 1 and a no-GPS report as ½. Reports of the same
 * hazard type within ~200 feet are the same hazard. "Not there" answers and
 * time bring confidence back down.
 */

const CREEK = { lat: 37.8659, lng: -119.5362 }; // waypoint scl-wp1
const NEAR_CREEK = { lat: 37.86595, lng: -119.53622 }; // ~6m away
const FIFTY_M_NORTH = { lat: 37.86635, lng: -119.5362 }; // ~50m (~165ft) from CREEK
const EIGHTY_M_NORTH = { lat: 37.86662, lng: -119.5362 }; // ~80m (~260ft) from CREEK
const FAR_AWAY = { lat: 37.88, lng: -119.5362 }; // ~1.6km away
const HOUR = 60 * 60 * 1000;
const REVIEWER_TOKEN = 'test-reviewer-token-0123456789abcdef0123456789';

describe('Use case: hazards are shared with a confidence score that hikers build up (Waze-style)', () => {
  const app = createApp({ writeRateLimit: false });
  let seq = 0;

  beforeEach(() => {
    resetHazards();
    delete process.env.OFFGRID_REVIEWER_TOKEN;
  });

  const report = (reporterId: string, overrides: Record<string, unknown> = {}) =>
    request(app)
      .post('/hazards/reports')
      .send({
        trailId: SHADOW_CREEK_TRAIL_ID,
        hazardType: 'downed_tree',
        severity: 'moderate',
        description: 'Large fallen tree blocking the trail, passable with care.',
        reportedAt: new Date().toISOString(),
        location: NEAR_CREEK,
        gpsWeakOrMissing: false,
        reporterId,
        ...overrides,
      });

  const vote = (incidentId: string, voterId: string, v: 'still_there' | 'not_there', overrides: Record<string, unknown> = {}) =>
    request(app)
      .post('/hazards/votes')
      .send({
        id: `vote-${++seq}`,
        incidentId,
        trailId: SHADOW_CREEK_TRAIL_ID,
        vote: v,
        observedAt: new Date().toISOString(),
        location: NEAR_CREEK,
        gpsWeakOrMissing: false,
        voterId,
        ...overrides,
      });

  const sharedHazards = async () => (await request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`)).body.hazards;

  describe('confidence tiers', () => {
    it('shares a hazard from the first report, as very low confidence', async () => {
      const res = await report('hiker-1');
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('verified');
      expect(res.body.message).toMatch(/unconfirmed/);
      const [hazard] = await sharedHazards();
      expect(hazard).toMatchObject({ confirmations: 1, confidenceLevel: 'very_low', waypointId: 'scl-wp1' });
    });

    it('climbs very low → low → medium → high as more hikers confirm', async () => {
      const first = await report('hiker-1');
      const levelAfter = async (hikers: number) => {
        const current = listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)[0].confirmations;
        for (let i = current + 1; i <= hikers; i++) await vote(first.body.incidentId, `hiker-${i}`, 'still_there');
        return (await sharedHazards())[0].confidenceLevel;
      };
      expect(await levelAfter(2)).toBe('very_low');
      expect(await levelAfter(3)).toBe('low');
      expect(await levelAfter(4)).toBe('low');
      expect(await levelAfter(5)).toBe('medium');
      expect(await levelAfter(9)).toBe('medium');
      expect(await levelAfter(10)).toBe('high');
    });

    it('counts hikers without GPS as half, so the tier reflects how sure we are they were there', async () => {
      const noGps = { location: undefined, waypointHintId: 'scl-wp1', gpsWeakOrMissing: true };
      for (let i = 1; i <= 6; i++) await report(`hiker-${i}`, noGps);
      const [hazard] = await sharedHazards();
      expect(hazard.confirmations).toBe(6);
      expect(hazard.confidence).toBeCloseTo(3, 2);
      expect(hazard.confidenceLevel).toBe('low'); // 6 on-the-spot hikers would be medium
    });

    it('does not let the same hiker confirm their own report', async () => {
      const first = await report('hiker-1');
      await report('hiker-1');
      await vote(first.body.incidentId, 'hiker-1', 'still_there');
      expect(listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)[0].confirmations).toBe(1);
    });

    it('treats a severe report like any other: shown right away, at very low confidence', async () => {
      await report('hiker-1', { severity: 'impassable', hazardType: 'bridge_out' });
      const [hazard] = await sharedHazards();
      expect(hazard).toMatchObject({ severity: 'impassable', confidenceLevel: 'very_low', confirmations: 1 });
    });

    it('keeps the reported severity when the reporter later says "not there" (Ironhide: BUG-020)', async () => {
      const first = await report('hiker-1', { severity: 'severe', hazardType: 'washout' });
      await vote(first.body.incidentId, 'hiker-2', 'still_there');
      await vote(first.body.incidentId, 'hiker-3', 'still_there');
      await vote(first.body.incidentId, 'hiker-1', 'not_there'); // replaces hiker-1's own report
      const inc = listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)[0];
      expect(inc.severity).toBe('severe'); // was silently downgraded to 'minor'
    });

    it('does not let one hiker escalate a hazard others called moderate', async () => {
      await report('hiker-1', { severity: 'moderate' });
      await report('hiker-2', { severity: 'moderate' });
      await report('hiker-3', { severity: 'impassable' });
      const [hazard] = await sharedHazards();
      expect(hazard.severity).toBe('moderate');
    });
  });

  describe('what counts as "the same hazard"', () => {
    it('merges reports of the same hazard type within ~200 feet', async () => {
      const a = await report('hiker-1', { location: CREEK });
      const b = await report('hiker-2', { location: FIFTY_M_NORTH });
      expect(b.body.incidentId).toBe(a.body.incidentId);
      expect(await sharedHazards()).toHaveLength(1);
    });

    it('keeps reports more than ~200 feet apart separate', async () => {
      const a = await report('hiker-1', { location: CREEK });
      const b = await report('hiker-2', { location: EIGHTY_M_NORTH });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
    });

    it('keeps different hazard types at the same spot separate', async () => {
      const a = await report('hiker-1', { hazardType: 'downed_tree' });
      const b = await report('hiker-2', { hazardType: 'flooding' });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
      expect(listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID).map((i) => i.confirmations)).toEqual([1, 1]);
    });

    it('never merges reports that have no position at all', async () => {
      const a = await report('hiker-1', { location: undefined });
      const b = await report('hiker-2', { location: undefined });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
    });
  });

  describe('"not there" and time', () => {
    it('lets one on-the-spot "not there" cancel a single report', async () => {
      const res = await report('hiker-1', { severity: 'impassable', hazardType: 'bridge_out' });
      const denied = await vote(res.body.incidentId, 'hiker-2', 'not_there', { location: CREEK });
      expect(denied.body.status).toBe('resolved');
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('lowers the tier with each "not there", and clears it once denials outweigh confirmations', async () => {
      const first = await report('hiker-1');
      await report('hiker-2');
      await report('hiker-3');
      expect((await sharedHazards())[0].confidenceLevel).toBe('low'); // 3

      await vote(first.body.incidentId, 'hiker-4', 'not_there');
      expect((await sharedHazards())[0].confidenceLevel).toBe('very_low'); // 3 - 1 = 2
      await vote(first.body.incidentId, 'hiker-5', 'not_there');
      const res = await vote(first.body.incidentId, 'hiker-6', 'not_there');
      expect(res.body.status).toBe('resolved'); // 3 - 3 = 0
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('fades a hazard out if nobody re-confirms it, faster for short-lived hazard types', async () => {
      const t0 = Date.now();
      await report('hiker-1', { hazardType: 'flooding' });
      await report('hiker-1', { hazardType: 'downed_tree' });

      const typesAt = (hoursLater: number) =>
        getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + hoursLater * HOUR).map((h) => h.hazardType).sort();
      expect(typesAt(0)).toEqual(['downed_tree', 'flooding']);
      expect(typesAt(72)).toEqual(['downed_tree']); // flooding (1-day half-life): one report lasts ~2 days
      expect(typesAt(24 * 15)).toEqual([]); // downed tree (7-day half-life): ~2 weeks

      const flooding = listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + 4 * 24 * HOUR).find((i) => i.hazardType === 'flooding');
      expect(flooding?.status).toBe('expired');
    });

    it('drops a tier as confirmations age', async () => {
      const t0 = Date.now();
      const first = await report('hiker-1');
      for (let i = 2; i <= 10; i++) await vote(first.body.incidentId, `hiker-${i}`, 'still_there');
      const levelAt = (h: number) => getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + h * HOUR)[0].confidenceLevel;
      const halfLife = HALF_LIFE_HOURS.downed_tree;
      expect(levelAt(0)).toBe('high'); // 10
      expect(levelAt(halfLife - 1)).toBe('medium'); // just over 5
      expect(levelAt(halfLife + 1)).toBe('low'); // just under 5
    });

    it('ships an expiresAt that matches when it actually stops being shared (Ironhide: BUG-017)', async () => {
      const t0 = Date.now();
      await report('hiker-1', { hazardType: 'flooding' });
      const [hazard] = getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0);
      const expires = Date.parse(hazard.expiresAt);
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, expires - 60_000)).toHaveLength(1);
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, expires + 60_000)).toHaveLength(0);
    });

    it('decays by when the hiker SAW it, not when their phone synced', async () => {
      const threeDaysAgo = new Date(Date.now() - 72 * HOUR).toISOString();
      const late = await report('hiker-1', { hazardType: 'flooding', reportedAt: threeDaysAgo });
      expect(late.body.status).not.toBe('verified'); // a 3-day-old flooding sighting is stale
    });

    it('lets "still there" keep a hazard alive', async () => {
      const t0 = Date.now();
      const first = await report('hiker-1', { hazardType: 'flooding' });
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + 60 * HOUR)).toHaveLength(0);
      for (const h of ['hiker-2', 'hiker-3', 'hiker-4']) await vote(first.body.incidentId, h, 'still_there');
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + 60 * HOUR)).toHaveLength(1);
    });

    it("uses each hiker's latest answer only (changing your mind replaces your vote)", async () => {
      const first = await report('hiker-1');
      await vote(first.body.incidentId, 'hiker-2', 'still_there');
      await vote(first.body.incidentId, 'hiker-2', 'not_there');
      const inc = listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)[0];
      expect(inc.confirmations).toBe(1);
      expect(inc.denials).toBe(1);
    });
  });

  describe('vote safeguards', () => {
    it('refuses votes from hikers whose GPS shows they were nowhere near it', async () => {
      const first = await report('hiker-1');
      const res = await vote(first.body.incidentId, 'hiker-2', 'not_there', { location: FAR_AWAY });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('too_far_from_hazard');
    });

    it('rejects votes and reports timestamped in the future (they would never decay)', async () => {
      const first = await report('hiker-1');
      const future = new Date(Date.now() + 24 * HOUR).toISOString();
      expect((await vote(first.body.incidentId, 'hiker-2', 'still_there', { observedAt: future })).status).toBe(400);
      expect((await report('hiker-3', { reportedAt: future })).status).toBe(400);
    });

    it('404s for an unknown hazard or a hazard on another trail', async () => {
      expect((await vote('hz-nope', 'hiker-2', 'still_there')).status).toBe(404);
      const first = await report('hiker-1');
      expect((await vote(first.body.incidentId, 'hiker-2', 'still_there', { trailId: 'other-trail' })).status).toBe(404);
    });

    it('treats a resent vote as a retry, not a second vote', async () => {
      const first = await report('hiker-1');
      const body = { id: 'vote-retry', incidentId: first.body.incidentId, trailId: SHADOW_CREEK_TRAIL_ID, vote: 'still_there', observedAt: new Date().toISOString(), location: NEAR_CREEK, voterId: 'hiker-2' };
      const a = await request(app).post('/hazards/votes').send(body);
      const b = await request(app).post('/hazards/votes').send(body);
      expect(a.status).toBe(202);
      expect(b.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect((await request(app).post('/hazards/votes').send({ ...body, voterId: 'someone-else' })).status).toBe(409);
    });

    it('rejects malformed votes and reports', async () => {
      const first = await report('hiker-1');
      expect((await vote(first.body.incidentId, 'hiker-2', 'maybe' as 'still_there')).status).toBe(400);
      expect((await vote('../etc', 'hiker-2', 'still_there')).status).toBe(400);
      expect((await request(app).post('/hazards/reports').send({ trailId: SHADOW_CREEK_TRAIL_ID })).status).toBe(400);
    });
  });

  describe('reputation and human review', () => {
    const auth = { Authorization: `Bearer ${REVIEWER_TOKEN}` };
    beforeEach(() => {
      process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
    });

    it("raises a reporter's trust only once another hiker independently confirms their report", async () => {
      await report('hiker-1');
      expect(getTrust('hiker-1')).toBe(TRUST_DEFAULT);
      await report('hiker-2');
      expect(getTrust('hiker-1')).toBeGreaterThan(TRUST_DEFAULT);
    });

    it('lets a reviewer reject a false hazard: it is never shared again and vouching for it costs trust', async () => {
      const first = await report('troll-1', { severity: 'impassable', hazardType: 'bridge_out' });
      expect(await sharedHazards()).toHaveLength(1);

      const res = await request(app).post(`/hazards/${first.body.incidentId}/reject`).set(auth);
      expect(res.body.status).toBe('rejected');
      expect(await sharedHazards()).toHaveLength(0);
      expect(getTrust('troll-1')).toBeLessThan(TRUST_DEFAULT);
      expect((await vote(first.body.incidentId, 'troll-2', 'still_there')).status).toBe(409);
    });

    it('lets a reviewer verify a hazard (e.g. a ranger confirmed it)', async () => {
      const first = await report('hiker-1');
      const res = await request(app).post(`/hazards/${first.body.incidentId}/verify`).set(auth);
      expect(res.body.status).toBe('verified');
      expect((await sharedHazards())[0].verifiedBy).toBe('reviewer');
    });

    it('lets a reviewer mark a hazard resolved', async () => {
      const first = await report('hiker-1');
      await request(app).post(`/hazards/${first.body.incidentId}/resolve`).set(auth);
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('lets reviewers list every incident with its score, but nobody else', async () => {
      await report('hiker-1');
      const res = await request(app).get(`/hazards/incidents?trailId=${SHADOW_CREEK_TRAIL_ID}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ status: 'verified', confirmations: 1, confidenceLevel: 'very_low' });
      expect((await request(app).get(`/hazards/incidents?trailId=${SHADOW_CREEK_TRAIL_ID}`)).status).toBe(401);
    });

    it('requires the reviewer token for review actions', async () => {
      const first = await report('hiker-1');
      expect((await request(app).post(`/hazards/${first.body.incidentId}/verify`)).status).toBe(401);
    });
  });
});
