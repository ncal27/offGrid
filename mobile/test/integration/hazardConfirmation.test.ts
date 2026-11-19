import { GpsFix, HazardReport, HazardVoteUpload } from '@offgrid/shared';
import { activeHazards, hazardConfidenceLabel, HazardVoteQueue, OfflineNavigator } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { testTrail, TEST_TRAIL_ID } from '../../src/testUtils/fixtures';

/**
 * Use case: Waze-style "Is it still there?" on the trail, fully offline. A
 * hiker with a downloaded package walks toward a known hazard. The app warns
 * them and asks if it's still there; the answer is queued on the phone and
 * synced when they're back in signal. Warnings that have gone stale are
 * dropped on the phone without needing a connection.
 */
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-19T15:00:00.000Z');

const downedTree = (overrides: Partial<HazardReport> = {}): HazardReport => ({
  id: 'hz-tree',
  trailId: TEST_TRAIL_ID,
  waypointId: 'scl-wp1',
  hazardType: 'downed_tree',
  severity: 'moderate',
  reportedAt: new Date(T0 - 2 * HOUR).toISOString(),
  status: 'verified',
  location: { lat: 37.8659, lng: -119.5362 },
  confidence: 2,
  confidenceLevel: 'medium',
  confirmations: 2,
  denials: 0,
  lastConfirmedAt: new Date(T0 - 2 * HOUR).toISOString(),
  expiresAt: new Date(T0 + 48 * HOUR).toISOString(),
  verifiedBy: 'community',
  ...overrides,
});

const fixAt = (lat: number, lng: number, t = T0): GpsFix => ({
  location: { lat, lng },
  accuracyMeters: 8,
  timestamp: new Date(t).toISOString(),
});

describe('Use case: confirming hazards on the trail, offline', () => {
  it('warns once when the hiker gets near a hazard, the cue to ask "still there?"', () => {
    const nav = new OfflineNavigator(testTrail, { hazards: [downedTree()] });

    const farEvents = nav.processFix(fixAt(37.8651, -119.5383)); // trailhead, ~200m+ away
    expect(farEvents.some((e) => e.type === 'approaching_hazard')).toBe(false);

    const nearEvents = nav.processFix(fixAt(37.8664, -119.5362)); // ~55m from the tree
    const prompt = nearEvents.find((e) => e.type === 'approaching_hazard');
    expect(prompt?.hazardId).toBe('hz-tree');

    // Standing there doesn't re-prompt on every GPS tick.
    expect(nav.processFix(fixAt(37.8659, -119.5362)).some((e) => e.type === 'approaching_hazard')).toBe(false);
  });

  it('places a hazard at its waypoint if it has no exact location', () => {
    const nav = new OfflineNavigator(testTrail, { hazards: [downedTree({ location: undefined })] });
    expect(nav.processFix(fixAt(37.8659, -119.5362)).some((e) => e.type === 'approaching_hazard')).toBe(true);
  });

  it('drops warnings that have expired, even mid-trip with no signal', () => {
    const hazards = [downedTree({ expiresAt: new Date(T0 + 1 * HOUR).toISOString() })];
    expect(activeHazards(hazards, T0)).toHaveLength(1);
    expect(activeHazards(hazards, T0 + 2 * HOUR)).toHaveLength(0);

    const nav = new OfflineNavigator(testTrail, { hazards });
    const events = nav.processFix(fixAt(37.8659, -119.5362, T0 + 2 * HOUR));
    expect(events.some((e) => e.type === 'approaching_hazard')).toBe(false);
  });

  it('queues the answer offline and syncs it on reconnect, keeping the time it was seen', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false }).mockPost('/hazards/votes', {
      id: 'v1',
      incidentId: 'hz-tree',
      status: 'resolved',
      confidence: 0,
      message: 'Thanks. Marked as possibly cleared.',
    });
    const queue = new HazardVoteQueue(storage, network);

    const seenAt = new Date(Date.now() - 3 * HOUR).toISOString();
    const answer: HazardVoteUpload = {
      id: 'v1',
      incidentId: 'hz-tree',
      trailId: TEST_TRAIL_ID,
      vote: 'not_there',
      observedAt: seenAt,
      location: { lat: 37.8659, lng: -119.5362 },
      gpsWeakOrMissing: false,
      voterId: 'hiker-9',
    };
    await queue.enqueue(answer);

    expect(await queue.flush()).toEqual([]); // still offline
    expect(await queue.pending()).toHaveLength(1);

    network.online = true;
    const acks = await queue.flush();
    expect(acks[0].status).toBe('resolved');
    expect(network.postCalls[0]).toEqual({ path: '/hazards/votes', body: answer });
    expect((network.postCalls[0].body as HazardVoteUpload).observedAt).toBe(seenAt);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('refuses to queue a malformed or future-dated answer', async () => {
    const queue = new HazardVoteQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    const base: HazardVoteUpload = {
      id: 'v2',
      incidentId: 'hz-tree',
      trailId: TEST_TRAIL_ID,
      vote: 'still_there',
      observedAt: new Date().toISOString(),
      gpsWeakOrMissing: true,
      voterId: 'hiker-9',
    };
    await expect(queue.enqueue({ ...base, vote: 'maybe' as HazardVoteUpload['vote'] })).rejects.toThrow('vote');
    await expect(
      queue.enqueue({ ...base, observedAt: new Date(Date.now() + 24 * HOUR).toISOString() }),
    ).rejects.toThrow('observedAt');
    await expect(queue.enqueue(base)).resolves.toBeUndefined();
  });

  it('labels fading or low-confidence warnings so hikers can judge them', () => {
    expect(hazardConfidenceLabel(downedTree({ confidenceLevel: 'low', confirmations: 3 }))).toBe(
      'Reported by 3 hikers · may be outdated',
    );
    expect(hazardConfidenceLabel(downedTree({ confirmations: 4, confidenceLevel: 'high' }))).toBe('Confirmed by 4 hikers');
    expect(hazardConfidenceLabel(downedTree({ verifiedBy: 'reviewer' }))).toBe('Confirmed by a ranger/reviewer');
  });
});
