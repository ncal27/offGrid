import request from 'supertest';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import {
  _resetForTests as resetHazards,
  getTrust,
  getVerifiedHazardsForTrail,
  listIncidentsForTrail,
  listPendingForTrail,
  TRUST_DEFAULT,
} from '../../src/services/hazardService';

/**
 * Use case: Waze-style hazard verification for hikers. A hiker reports a
 * hazard (often offline, synced later). It's only shared with other hikers
 * once enough confidence builds up from independent, nearby reports and
 * "still there?" answers. Confidence fades over time, "not there" answers
 * take it down, and worse hazards need less proof to be shown (as an
 * unconfirmed warning).
 */

const CREEK = { lat: 37.8659, lng: -119.5362 }; // waypoint scl-wp1
const NEAR_CREEK = { lat: 37.86595, lng: -119.53622 }; // ~6m away
const UP_THE_TRAIL = { lat: 37.8679, lng: -119.5362 }; // ~220m away
const FAR_AWAY = { lat: 37.88, lng: -119.5362 }; // ~1.6km away
const HOUR = 60 * 60 * 1000;
const REVIEWER_TOKEN = 'test-reviewer-token-0123456789abcdef0123456789';

describe('Use case: hazards are verified by hikers before they are shared (Waze-style)', () => {
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

  describe('building confidence', () => {
    it('does not share a single ordinary report', async () => {
      const res = await report('hiker-1');
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('pending_review');
      expect(res.body.incidentId).toBeDefined();
      expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('shares it once a second hiker on the spot reports the same thing, merged into one hazard', async () => {
      const first = await report('hiker-1');
      const second = await report('hiker-2', { location: CREEK });
      expect(second.body.incidentId).toBe(first.body.incidentId);
      expect(second.body.status).toBe('verified');

      const hazards = await sharedHazards();
      expect(hazards).toHaveLength(1);
      expect(hazards[0]).toMatchObject({
        id: first.body.incidentId,
        hazardType: 'downed_tree',
        waypointId: 'scl-wp1',
        confirmations: 2,
        denials: 0,
        confidenceLevel: 'medium',
        verifiedBy: 'community',
      });
      expect(hazards[0].confidence).toBeCloseTo(2, 2);
      expect(Date.parse(hazards[0].expiresAt)).toBeGreaterThan(Date.now());
    });

    it('lets a passing hiker confirm with "still there", the same as a second report', async () => {
      const first = await report('hiker-1');
      const res = await vote(first.body.incidentId, 'hiker-2', 'still_there');
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('verified');
      expect(await sharedHazards()).toHaveLength(1);
    });

    it('raises the confidence level as more hikers confirm', async () => {
      const first = await report('hiker-1');
      for (const h of ['hiker-2', 'hiker-3', 'hiker-4']) await vote(first.body.incidentId, h, 'still_there');
      const [hazard] = await sharedHazards();
      expect(hazard.confirmations).toBe(4);
      expect(hazard.confidenceLevel).toBe('high');
    });

    it('counts reports without GPS as half, since we cannot tell the hiker was really there', async () => {
      const noGps = { location: undefined, waypointHintId: 'scl-wp1', gpsWeakOrMissing: true };
      const a = await report('hiker-1', noGps);
      const b = await report('hiker-2', noGps);
      // Reports with only a waypoint hint still merge (they share the waypoint's position)...
      expect(b.body.incidentId).toBe(a.body.incidentId);
      // ...but 0.5 + 0.5 is not enough.
      expect(b.body.status).toBe('pending_review');

      const c = await report('hiker-3', { location: CREEK }); // one on-the-spot hiker tips it over
      expect(c.body.status).toBe('verified');
    });

    it('does not let the same hiker confirm their own report', async () => {
      const first = await report('hiker-1');
      await report('hiker-1');
      const res = await vote(first.body.incidentId, 'hiker-1', 'still_there');
      expect(res.body.status).toBe('pending_review');
      expect(listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)[0].confirmations).toBe(1);
    });
  });

  describe('what counts as "the same hazard"', () => {
    it('keeps different hazard types at the same spot separate', async () => {
      const a = await report('hiker-1', { hazardType: 'downed_tree' });
      const b = await report('hiker-2', { hazardType: 'flooding' });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
      expect(b.body.status).toBe('pending_review');
      expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(2);
    });

    it('keeps reports more than 75m apart separate', async () => {
      const a = await report('hiker-1', { location: CREEK });
      const b = await report('hiker-2', { location: UP_THE_TRAIL });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
    });

    it('never merges reports that have no position at all', async () => {
      const a = await report('hiker-1', { location: undefined });
      const b = await report('hiker-2', { location: undefined });
      expect(b.body.incidentId).not.toBe(a.body.incidentId);
      expect(await sharedHazards()).toHaveLength(0);
    });
  });

  describe('severe hazards (asymmetric risk)', () => {
    it('shares an impassable report right away, but as a low-confidence warning', async () => {
      const res = await report('hiker-1', { severity: 'impassable', hazardType: 'bridge_out' });
      expect(res.body.status).toBe('verified');
      const [hazard] = await sharedHazards();
      expect(hazard).toMatchObject({ severity: 'impassable', confidenceLevel: 'low', verifiedBy: 'urgent_report' });
    });

    it('takes an unconfirmed impassable warning down after one on-the-spot "not there"', async () => {
      const res = await report('hiker-1', { severity: 'impassable', hazardType: 'bridge_out', location: undefined, waypointHintId: 'scl-wp1' });
      const denied = await vote(res.body.incidentId, 'hiker-2', 'not_there', { location: CREEK });
      expect(denied.body.status).toBe('resolved');
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('does not let one hiker escalate a hazard others called moderate', async () => {
      await report('hiker-1', { severity: 'moderate' });
      await report('hiker-2', { severity: 'moderate' });
      await report('hiker-3', { severity: 'impassable' });
      const [hazard] = await sharedHazards();
      expect(hazard.severity).toBe('moderate');
    });
  });

  describe('"not there" and time', () => {
    it('clears a shared hazard once enough hikers say it is gone', async () => {
      const first = await report('hiker-1');
      await report('hiker-2');
      expect(await sharedHazards()).toHaveLength(1);

      await vote(first.body.incidentId, 'hiker-3', 'not_there');
      expect(await sharedHazards()).toHaveLength(0); // 2 - 1 = 1 < 1.5: no longer confident enough to share
      const res = await vote(first.body.incidentId, 'hiker-4', 'not_there');
      expect(res.body.status).toBe('resolved');
    });

    it('fades a shared hazard out if nobody re-confirms it, faster for short-lived hazard types', async () => {
      const t0 = Date.now();
      await report('hiker-1', { hazardType: 'flooding' });
      await report('hiker-2', { hazardType: 'flooding' });
      await report('hiker-1', { hazardType: 'downed_tree' });
      await report('hiker-2', { hazardType: 'downed_tree' });

      const typesAt = (hoursLater: number) =>
        getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + hoursLater * HOUR).map((h) => h.hazardType).sort();
      expect(typesAt(0)).toEqual(['downed_tree', 'flooding']);
      expect(typesAt(12)).toEqual(['downed_tree']); // flooding half-life 1 day: gone after ~10h
      expect(typesAt(24 * 4)).toEqual([]); // downed tree half-life 7 days: gone after ~3 days

      const flooding = listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + 4 * 24 * HOUR).find((i) => i.hazardType === 'flooding');
      expect(flooding?.status).toBe('expired');
    });

    it('ships an expiresAt that matches when it actually stops being shared', async () => {
      const t0 = Date.now();
      await report('hiker-1', { hazardType: 'flooding' });
      await report('hiker-2', { hazardType: 'flooding' });
      const [hazard] = getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0);
      const expires = Date.parse(hazard.expiresAt);
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, expires - 60_000)).toHaveLength(1);
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, expires + 60_000)).toHaveLength(0);
    });

    it('decays by when the hiker SAW it, not when their phone synced', async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * HOUR).toISOString();
      await report('hiker-1', { hazardType: 'flooding', reportedAt: twoDaysAgo });
      const late = await report('hiker-2', { hazardType: 'flooding', reportedAt: twoDaysAgo });
      expect(late.body.status).not.toBe('verified'); // two 2-day-old flooding sightings are stale
    });

    it('lets "still there" keep a hazard alive', async () => {
      const t0 = Date.now();
      const first = await report('hiker-1', { hazardType: 'flooding' });
      await report('hiker-2', { hazardType: 'flooding' });
      await vote(first.body.incidentId, 'hiker-3', 'still_there');
      await vote(first.body.incidentId, 'hiker-4', 'still_there');
      // Four confirmations last longer than two (≈ 1.4 half-lives instead of 0.4).
      expect(getVerifiedHazardsForTrail(SHADOW_CREEK_TRAIL_ID, t0 + 24 * HOUR)).toHaveLength(1);
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

    it('rejects votes timestamped in the future (they would never decay)', async () => {
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

    it('rejects malformed votes', async () => {
      const first = await report('hiker-1');
      expect((await vote(first.body.incidentId, 'hiker-2', 'maybe' as 'still_there')).status).toBe(400);
      expect((await vote('../etc', 'hiker-2', 'still_there')).status).toBe(400);
    });

    it('rejects a report missing required fields', async () => {
      const res = await request(app).post('/hazards/reports').send({ trailId: SHADOW_CREEK_TRAIL_ID });
      expect(res.status).toBe(400);
    });
  });

  describe('reputation and human review', () => {
    const auth = { Authorization: `Bearer ${REVIEWER_TOKEN}` };
    beforeEach(() => {
      process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
    });

    it('raises a reporter\'s trust when other hikers independently confirm their report', async () => {
      await report('hiker-1');
      await report('hiker-2');
      expect(getTrust('hiker-1')).toBeGreaterThan(TRUST_DEFAULT);
    });

    it('lets a reviewer reject a false hazard: it is never shared again and vouching for it costs trust', async () => {
      const first = await report('troll-1', { severity: 'impassable', hazardType: 'bridge_out' });
      expect(await sharedHazards()).toHaveLength(1);

      const res = await request(app).post(`/hazards/${first.body.incidentId}/reject`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(await sharedHazards()).toHaveLength(0);
      expect(getTrust('troll-1')).toBeLessThan(TRUST_DEFAULT);

      // Further votes on a rejected hazard are refused.
      expect((await vote(first.body.incidentId, 'troll-2', 'still_there')).status).toBe(409);
    });

    it('lets a reviewer verify a report (e.g. a ranger confirmed it), which hikers can still outvote later', async () => {
      const first = await report('hiker-1');
      const res = await request(app).post(`/hazards/${first.body.incidentId}/verify`).set(auth);
      expect(res.body.status).toBe('verified');
      expect((await sharedHazards())[0].verifiedBy).toBe('reviewer');
    });

    it('lets a reviewer mark a hazard resolved', async () => {
      const first = await report('hiker-1');
      await report('hiker-2');
      await request(app).post(`/hazards/${first.body.incidentId}/resolve`).set(auth);
      expect(await sharedHazards()).toHaveLength(0);
    });

    it('lets reviewers list every incident with its score, but nobody else', async () => {
      await report('hiker-1');
      const res = await request(app).get(`/hazards/incidents?trailId=${SHADOW_CREEK_TRAIL_ID}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ status: 'pending_review', confirmations: 1 });
      expect((await request(app).get(`/hazards/incidents?trailId=${SHADOW_CREEK_TRAIL_ID}`)).status).toBe(401);
    });

    it('requires the reviewer token for review actions', async () => {
      const first = await report('hiker-1');
      expect((await request(app).post(`/hazards/${first.body.incidentId}/verify`)).status).toBe(401);
    });
  });
});
