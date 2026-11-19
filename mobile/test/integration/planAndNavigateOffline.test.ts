import { GpsFix, TripPackage } from '@offgrid/shared';
import { OfflineNavigator, PackageStore, TripPlannerClient } from '../../src/core';
import { FakeNetworkAdapter, InMemoryStorageAdapter } from '../../src/testUtils/mockAdapters';
import { TEST_TRAIL_ID, testTripPackage } from '../../src/testUtils/fixtures';

const fix = (lat: number, lng: number, accuracyMeters = 8): GpsFix => ({
  location: { lat, lng },
  accuracyMeters,
  timestamp: new Date().toISOString(),
});

/**
 * Use case: plan a trip while online, download it, then lose connectivity
 * entirely and still be able to navigate using only what's on the device.
 */
describe('Use case: plan + download online, then navigate fully offline', () => {
  it('downloads a trip package while online, then navigates the route with no network at all', async () => {
    const network = new FakeNetworkAdapter({ online: true })
      .mockGet(`/trails/search?q=${encodeURIComponent('Shadow Creek')}`, [
        {
          id: TEST_TRAIL_ID,
          name: 'Shadow Creek Loop',
          region: 'US-CA',
          distanceMeters: 8046,
          elevationGainMeters: 412,
          dataSource: 'usgs_usfs_nps',
        },
      ])
      .mockPost(`/trails/${TEST_TRAIL_ID}/package`, testTripPackage);

    const storage = new InMemoryStorageAdapter();
    const planner = new TripPlannerClient(network);
    const packageStore = new PackageStore(storage);

    // --- Online: plan and download ---
    const results = await planner.searchTrails('Shadow Creek');
    expect(results).toHaveLength(1);

    const pkg: TripPackage = await planner.fetchTripPackage(TEST_TRAIL_ID);
    await packageStore.save(pkg);

    // --- Go fully offline ---
    network.online = false;
    expect(await network.isOnline()).toBe(false);

    // Everything from here on must work from local storage only.
    const loadedPkg = await packageStore.load(TEST_TRAIL_ID);
    expect(loadedPkg).not.toBeNull();
    expect(loadedPkg!.trail.waypoints.length).toBe(2);

    const navigator = new OfflineNavigator(loadedPkg!.trail);

    // Walking right up to waypoint 1's coordinates should register as both
    // on-route and as reaching that waypoint, in the same fix.
    const atWaypointEvents = navigator.processFix(fix(37.8659, -119.5362));
    expect(atWaypointEvents.some((e) => e.type === 'on_route')).toBe(true);
    expect(
      atWaypointEvents.some((e) => e.type === 'reached_waypoint' && e.nearestWaypointId === 'scl-wp1'),
    ).toBe(true);

    // Reaching the same waypoint again should not re-fire reached_waypoint (Ironhide: BUG-001).
    const repeatEvents = navigator.processFix(fix(37.8659, -119.5362));
    expect(repeatEvents.some((e) => e.type === 'reached_waypoint')).toBe(false);

    // Wandering far from the route line should register as off-route.
    const offRouteEvents = navigator.processFix(fix(37.9, -119.6));
    expect(offRouteEvents.some((e) => e.type === 'off_route')).toBe(true);
  });

  it('lets a device that never had a chance to download still know it has nothing offline', async () => {
    const storage = new InMemoryStorageAdapter();
    const packageStore = new PackageStore(storage);
    expect(await packageStore.has(TEST_TRAIL_ID)).toBe(false);
    expect(await packageStore.load(TEST_TRAIL_ID)).toBeNull();
  });
});
