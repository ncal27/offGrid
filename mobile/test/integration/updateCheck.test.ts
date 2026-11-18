import { PackageStore, TripPlannerClient, UpdateChecker } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { TEST_TRAIL_ID, testTripPackage } from '../../src/testUtils/fixtures';

/**
 * Use case: next time the app has signal, tell the user whether a trail they
 * already downloaded has newer official data, without re-downloading it
 * just to find out.
 */
describe('Use case: check whether a downloaded trail is stale', () => {
  it('does not call a freshly-downloaded trail "stale" when the backend version matches', async () => {
    const network = new FakeNetworkAdapter().mockGet(`/trails/${TEST_TRAIL_ID}/version`, {
      trailId: TEST_TRAIL_ID,
      version: 1,
    });
    const storage = new InMemoryStorageAdapter();
    const packageStore = new PackageStore(storage);
    await packageStore.save(testTripPackage); // trailVersion: 1

    const checker = new UpdateChecker(new TripPlannerClient(network), packageStore);
    const result = await checker.checkTrail(TEST_TRAIL_ID);

    expect(result.hasLocalPackage).toBe(true);
    expect(result.localVersion).toBe(1);
    expect(result.latestVersion).toBe(1);
    expect(result.updateAvailable).toBe(false);
  });

  it('flags an update as available once the backend version has moved ahead', async () => {
    const network = new FakeNetworkAdapter().mockGet(`/trails/${TEST_TRAIL_ID}/version`, {
      trailId: TEST_TRAIL_ID,
      version: 2,
    });
    const storage = new InMemoryStorageAdapter();
    const packageStore = new PackageStore(storage);
    await packageStore.save(testTripPackage); // still trailVersion: 1 locally

    const checker = new UpdateChecker(new TripPlannerClient(network), packageStore);
    const result = await checker.checkTrail(TEST_TRAIL_ID);

    expect(result.updateAvailable).toBe(true);
    expect(result.localVersion).toBe(1);
    expect(result.latestVersion).toBe(2);
  });

  it('does not call a trail "stale" just because nothing has been downloaded yet', async () => {
    const network = new FakeNetworkAdapter().mockGet(`/trails/${TEST_TRAIL_ID}/version`, {
      trailId: TEST_TRAIL_ID,
      version: 5,
    });
    const packageStore = new PackageStore(new InMemoryStorageAdapter());

    const checker = new UpdateChecker(new TripPlannerClient(network), packageStore);
    const result = await checker.checkTrail(TEST_TRAIL_ID);

    expect(result.hasLocalPackage).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe(5);
  });
});
