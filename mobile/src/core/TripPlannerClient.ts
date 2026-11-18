import { isSafeId, Trail, TrailSummary, TrailVersionInfo, TripPackage } from '@offgrid/shared';
import { NetworkAdapter } from './adapters';

/**
 * trailId is interpolated into a URL path. Without this, an id like
 * "../contributions/x/promote" turned GET /trails/:id into a request to a
 * completely different endpoint (BUG-012). Validate first, and still encode.
 */
function trailPath(trailId: string, suffix = ''): string {
  if (!isSafeId(trailId)) throw new Error('Invalid trail id');
  return `/trails/${encodeURIComponent(trailId)}${suffix}`;
}

/**
 * Online-only planning calls. Everything this class does requires
 * connectivity; once a TripPackage has been fetched and saved via
 * PackageStore, none of this is needed again until the user plans their next
 * trip or wants a refreshed/updated package.
 */
export class TripPlannerClient {
  constructor(private network: NetworkAdapter) {}

  async searchTrails(query: string): Promise<TrailSummary[]> {
    return this.network.get<TrailSummary[]>(`/trails/search?q=${encodeURIComponent(query)}`);
  }

  async getTrail(trailId: string): Promise<Trail> {
    return this.network.get<Trail>(trailPath(trailId));
  }

  async fetchTripPackage(trailId: string): Promise<TripPackage> {
    const pkg = await this.network.post<TripPackage>(trailPath(trailId, '/package'), {});
    // Don't store a package under trail A that the server says is trail B.
    if (!pkg || pkg.trailId !== trailId || !Array.isArray(pkg.trail?.routeLine)) {
      throw new Error('Downloaded trip package does not match the requested trail');
    }
    return pkg;
  }

  /** Cheap check for staleness — doesn't fetch the full trail detail. */
  async checkTrailVersion(trailId: string): Promise<TrailVersionInfo> {
    return this.network.get<TrailVersionInfo>(trailPath(trailId, '/version'));
  }
}
