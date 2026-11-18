import { Trail, TrailSummary, TrailVersionInfo, TripPackage } from '@offgrid/shared';
import { NetworkAdapter } from './adapters';

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
    return this.network.get<Trail>(`/trails/${trailId}`);
  }

  async fetchTripPackage(trailId: string): Promise<TripPackage> {
    return this.network.post<TripPackage>(`/trails/${trailId}/package`, {});
  }

  /** Cheap check for staleness — doesn't fetch the full trail detail. */
  async checkTrailVersion(trailId: string): Promise<TrailVersionInfo> {
    return this.network.get<TrailVersionInfo>(`/trails/${trailId}/version`);
  }
}
