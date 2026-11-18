import { TrailVersionInfo, TripPackage } from '@offgrid/shared';
import { TripPlannerClient } from './TripPlannerClient';
import { PackageStore } from './PackageStore';

export interface UpdateCheckResult {
  trailId: string;
  hasLocalPackage: boolean;
  localVersion?: number;
  latestVersion: number;
  updateAvailable: boolean;
}

/**
 * Online-only check for whether a trail's official data has moved past what
 * a device already downloaded. Meant to run opportunistically whenever the
 * app has connectivity (e.g. on launch, pull-to-refresh) — not part of the
 * offline navigation path, and not something that blocks using an
 * already-downloaded package while offline.
 */
export class UpdateChecker {
  constructor(private planner: TripPlannerClient, private packageStore: PackageStore) {}

  async checkTrail(trailId: string): Promise<UpdateCheckResult> {
    const [localPkg, versionInfo]: [TripPackage | null, TrailVersionInfo] = await Promise.all([
      this.packageStore.load(trailId),
      this.planner.checkTrailVersion(trailId),
    ]);

    if (!localPkg) {
      // Nothing downloaded yet isn't "stale" — there's nothing to compare against.
      return {
        trailId,
        hasLocalPackage: false,
        latestVersion: versionInfo.version,
        updateAvailable: false,
      };
    }

    return {
      trailId,
      hasLocalPackage: true,
      localVersion: localPkg.trailVersion,
      latestVersion: versionInfo.version,
      updateAvailable: versionInfo.version > localPkg.trailVersion,
    };
  }
}
