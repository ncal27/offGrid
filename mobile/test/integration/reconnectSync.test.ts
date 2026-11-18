import { ContributedPhotoUpload } from '@offgrid/shared';
import { SyncQueue } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { TEST_TRAIL_ID } from '../../src/testUtils/fixtures';

/**
 * Use case: a hiker tags a landmark photo mid-hike with no signal, keeps
 * hiking, and the photo only reaches the backend once the device reconnects.
 */
describe('Use case: contribute a landmark photo offline, sync once reconnected', () => {
  const contribution: ContributedPhotoUpload = {
    id: 'contrib-1',
    trailId: TEST_TRAIL_ID,
    waypointHintId: 'scl-wp1',
    capturedAt: new Date().toISOString(),
    gpsWeakOrMissing: true,
    imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
    contributorId: 'hiker-42',
  };

  it('keeps a contributed photo queued locally while offline and does not attempt to send it', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false });
    const queue = new SyncQueue(storage, network);

    await queue.enqueue(contribution);
    expect(await queue.pending()).toHaveLength(1);

    const acks = await queue.flush();
    expect(acks).toHaveLength(0);
    expect(await queue.pending()).toHaveLength(1); // still queued, nothing was sent
  });

  it('uploads everything queued once the device reconnects, then clears the local queue', async () => {
    const storage = new InMemoryStorageAdapter();
    const network = new FakeNetworkAdapter({ online: false });
    const queue = new SyncQueue(storage, network);

    await queue.enqueue(contribution);

    // Device reconnects (e.g. back at the trailhead parking lot).
    network.online = true;
    network.mockPost('/contributions/photos', {
      id: contribution.id,
      status: 'pending_review',
      message: 'Received. This photo is queued for review and is not yet part of the official trail package.',
    });

    const acks = await queue.flush();

    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('pending_review');
    expect(network.postCalls).toHaveLength(1);
    expect(network.postCalls[0].path).toBe('/contributions/photos');
    expect(await queue.pending()).toHaveLength(0); // synced items are removed from the local queue
  });
});
