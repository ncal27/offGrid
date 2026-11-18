import { HazardReportUpload } from '@offgrid/shared';
import { HazardReportQueue } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { TEST_TRAIL_ID } from '../../src/testUtils/fixtures';

/**
 * Use case: a hiker reports a downed tree mid-hike with no signal, keeps
 * hiking, and the report only reaches the backend once the device
 * reconnects — same offline-first shape as photo contributions.
 */
describe('Use case: report a hazard offline, sync once reconnected', () => {
  const hazardReport: HazardReportUpload = {
    id: 'hazard-1',
    trailId: TEST_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    hazardType: 'downed_tree',
    severity: 'moderate',
    description: 'Large fallen tree blocking the trail just past the creek crossing.',
    reportedAt: new Date().toISOString(),
    gpsWeakOrMissing: true,
    reporterId: 'hiker-42',
  };

  it('keeps a hazard report queued locally while offline and does not attempt to send it', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false });
    const queue = new HazardReportQueue(storage, network);

    await queue.enqueue(hazardReport);
    expect(await queue.pending()).toHaveLength(1);

    const acks = await queue.flush();
    expect(acks).toHaveLength(0);
    expect(await queue.pending()).toHaveLength(1);
  });

  it('uploads a queued hazard report once the device reconnects, then clears the local queue', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false });
    const queue = new HazardReportQueue(storage, network);

    await queue.enqueue(hazardReport);

    network.online = true;
    network.mockPost('/hazards/reports', {
      id: hazardReport.id,
      status: 'pending_review',
      message: 'Received. This hazard report is queued for review and is not yet part of the official trail package.',
    });

    const acks = await queue.flush();

    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('pending_review');
    expect(network.postCalls).toHaveLength(1);
    expect(network.postCalls[0].path).toBe('/hazards/reports');
    expect(await queue.pending()).toHaveLength(0);
  });

  it('keeps hazard reports and photo contributions in separate local queues', async () => {
    // Regression check for the OfflineUploadQueue refactor: both queue types
    // share the same engine but must not collide in storage or in-flight state.
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false });
    const hazardQueue = new HazardReportQueue(storage, network);

    await hazardQueue.enqueue(hazardReport);
    const allKeys = await storage.listKeys('');
    expect(allKeys).toEqual(['hazard-queue/hazard-1.json']);
  });
});
