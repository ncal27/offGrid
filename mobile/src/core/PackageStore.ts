import { TripPackage } from '@offgrid/shared';
import { StorageAdapter } from './adapters';

const PACKAGE_PREFIX = 'trip-packages/';
const packageKey = (trailId: string) => `${PACKAGE_PREFIX}${trailId}.json`;

/**
 * Persists downloaded TripPackages locally so the app can read them with no
 * connectivity at all. This is the on-device "database" the rest of the app
 * (OfflineNavigator, LandmarkMatcher) is built to run against.
 */
export class PackageStore {
  constructor(private storage: StorageAdapter) {}

  async save(pkg: TripPackage): Promise<void> {
    await this.storage.writeJson(packageKey(pkg.trailId), pkg);
  }

  async load(trailId: string): Promise<TripPackage | null> {
    return this.storage.readJson<TripPackage>(packageKey(trailId));
  }

  async has(trailId: string): Promise<boolean> {
    return this.storage.exists(packageKey(trailId));
  }

  async listDownloadedTrailIds(): Promise<string[]> {
    const keys = await this.storage.listKeys(PACKAGE_PREFIX);
    return keys.map((k) => k.slice(PACKAGE_PREFIX.length).replace(/\.json$/, ''));
  }

  async remove(trailId: string): Promise<void> {
    await this.storage.remove(packageKey(trailId));
  }
}
