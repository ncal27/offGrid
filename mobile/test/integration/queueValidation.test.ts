import { ContributedPhotoUpload, HazardReportUpload } from '@offgrid/shared';
import { HazardReportQueue, SyncQueue } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { TEST_TRAIL_ID } from '../../src/testUtils/fixtures';

/**
 * Use case: a bug in the app (or a tampered client) tries to queue garbage
 * locally — it should be rejected before it's even written to the hiker's
 * phone storage, rather than silently queued and only failing later when
 * the device reconnects and the backend rejects it.
 */
describe('Use case: offline queues reject invalid data before storing it', () => {
  const validContribution: ContributedPhotoUpload = {
    id: 'contrib-1',
    trailId: TEST_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    capturedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
    contributorId: 'hiker-1',
  };

  const validHazardReport: HazardReportUpload = {
    id: 'hazard-1',
    trailId: TEST_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    hazardType: 'downed_tree',
    severity: 'moderate',
    reportedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    reporterId: 'hiker-1',
  };

  it('accepts a well-formed contribution (sanity check against the shared validators)', async () => {
    const queue = new SyncQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    await expect(queue.enqueue(validContribution)).resolves.toBeUndefined();
    expect(await queue.pending()).toHaveLength(1);
  });

  it('rejects a contribution with a path-traversal-style trailId before storing it', async () => {
    const storage = new InMemoryStorageAdapter();
    const queue = new SyncQueue(storage, new FakeNetworkAdapter());
    await expect(
      queue.enqueue({ ...validContribution, trailId: '../../etc/passwd' }),
    ).rejects.toThrow(/trailId/);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('rejects a contribution with an out-of-range location', async () => {
    const queue = new SyncQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    await expect(
      queue.enqueue({ ...validContribution, location: { lat: 500, lng: 0 } }),
    ).rejects.toThrow(/location/);
  });

  it('rejects a contribution whose imageBase64 is not even plausibly base64', async () => {
    const queue = new SyncQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    await expect(
      queue.enqueue({ ...validContribution, imageBase64: 'not base64 at all!!!' }),
    ).rejects.toThrow(/imageBase64/);
  });

  it('accepts a well-formed hazard report', async () => {
    const queue = new HazardReportQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    await expect(queue.enqueue(validHazardReport)).resolves.toBeUndefined();
    expect(await queue.pending()).toHaveLength(1);
  });

  it('rejects a hazard report with an unrecognized hazardType before storing it', async () => {
    const storage = new InMemoryStorageAdapter();
    const queue = new HazardReportQueue(storage, new FakeNetworkAdapter());
    await expect(
      queue.enqueue({ ...validHazardReport, hazardType: 'godzilla_attack' as HazardReportUpload['hazardType'] }),
    ).rejects.toThrow(/hazardType/);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('rejects a hazard report with an unrecognized severity', async () => {
    const queue = new HazardReportQueue(new InMemoryStorageAdapter(), new FakeNetworkAdapter());
    await expect(
      queue.enqueue({ ...validHazardReport, severity: 'catastrophic' as HazardReportUpload['severity'] }),
    ).rejects.toThrow(/severity/);
  });
});
