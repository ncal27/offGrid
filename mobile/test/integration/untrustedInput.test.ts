import { HazardReportUpload } from '@offgrid/shared';
import { HazardReportQueue, LandmarkMatcher, PackageStore, TripPlannerClient } from '../../src/core';
import { FakeEmbeddingAdapter, FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';

/**
 * Use case: the phone has to cope with bad input and bad responses, whether
 * that's a report the backend refuses, a connection that drops mid-sync, a
 * tampered ID, or a corrupt model output, without losing data or getting stuck.
 */
const report = (id: string): HazardReportUpload => ({
  id,
  trailId: 'shadow-creek-loop',
  hazardType: 'downed_tree',
  severity: 'moderate',
  reportedAt: new Date().toISOString(),
  gpsWeakOrMissing: false,
  reporterId: 'hiker-1',
});

describe('Use case: syncing survives rejected and interrupted uploads (BUG-011)', () => {
  it('does not let one permanently-rejected report block the rest of the queue', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter()
      .mockPost('/hazards/reports', { status: 'pending_review' })
      .failPostFor('a-rejected', 400);
    const queue = new HazardReportQueue(storage, network);
    await queue.enqueue(report('a-rejected'));
    await queue.enqueue(report('b-good'));

    const acks = await queue.flush();
    expect(acks).toHaveLength(1);
    expect(await queue.pending()).toHaveLength(0);

    // The hiker's rejected report isn't silently thrown away.
    const rejected = await queue.rejected();
    expect(rejected.map((r) => [r.upload.id, r.status])).toEqual([['a-rejected', 400]]);
  });

  it('keeps items queued when the connection drops mid-flush, and sends them next time', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter()
      .mockPost('/hazards/reports', { status: 'pending_review' })
      .failPostFor('a-first', 'network');
    const queue = new HazardReportQueue(storage, network);
    await queue.enqueue(report('a-first'));
    await queue.enqueue(report('b-second'));

    expect(await queue.flush()).toHaveLength(0);
    expect((await queue.pending()).map((p) => p.id).sort()).toEqual(['a-first', 'b-second']);
    expect(await queue.rejected()).toHaveLength(0);

    network.clearPostFailure('a-first');
    expect(await queue.flush()).toHaveLength(2);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('treats rate limiting and server errors as "try again later", not as rejection', async () => {
    for (const status of [429, 500, 503]) {
      const network = new FakeNetworkAdapter().mockPost('/hazards/reports', {}).failPostFor('x', status);
      const queue = new HazardReportQueue(new InMemoryStorageAdapter(), network);
      await queue.enqueue(report('x'));
      await queue.flush();
      expect(await queue.pending()).toHaveLength(1);
      expect(await queue.rejected()).toHaveLength(0);
    }
  });
});

describe('Use case: tampered or malformed IDs never reach URLs or file paths (BUG-012)', () => {
  it('refuses a path-traversal trail id instead of requesting a different endpoint', async () => {
    const network = new FakeNetworkAdapter();
    const client = new TripPlannerClient(network);
    await expect(client.getTrail('../contributions/x/promote')).rejects.toThrow('Invalid trail id');
    await expect(client.checkTrailVersion('a/b')).rejects.toThrow('Invalid trail id');
  });

  it('refuses to store a downloaded package for a different trail than requested', async () => {
    const network = new FakeNetworkAdapter().mockPost('/trails/trail-a/package', {
      trailId: 'trail-b',
      trail: { routeLine: [] },
    });
    await expect(new TripPlannerClient(network).fetchTripPackage('trail-a')).rejects.toThrow('does not match');
  });

  it('refuses to write a trip package outside its storage folder', async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new PackageStore(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(store.save({ trailId: '../../secrets/evil' } as any)).rejects.toThrow('Invalid trail id');
    expect(await storage.listKeys('')).toHaveLength(0);
  });
});

describe('Use case: a corrupt embedding does not produce a nonsense match (BUG-013)', () => {
  it('scores NaN/Infinity embeddings as no match instead of NaN confidence', async () => {
    const matcher = new LandmarkMatcher(new FakeEmbeddingAdapter({ q: [NaN, 1] }));
    const result = await matcher.matchPhoto('q', [
      { id: 'p1', waypointId: 'w1', trailId: 't', source: 'official', status: 'official', capturedAt: '', uri: '', embedding: [1, 0] },
      { id: 'p2', waypointId: 'w2', trailId: 't', source: 'official', status: 'official', capturedAt: '', uri: '', embedding: [0, 1] },
    ]);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.candidates.every((c) => c.similarity === 0)).toBe(true);
  });
});
