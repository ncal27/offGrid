import { Trail, TrailSummary } from '@offgrid/shared';
import { trailsById as fixtureTrailsById } from '../data/fixtures';

/**
 * Mutable in-memory copy of the fixture trails (same seed/reset pattern as
 * landmarkPhotoService), so version bumps used to exercise the update-check
 * flow don't permanently mutate the fixture module itself across test runs.
 */
function seedTrails(): Map<string, Trail> {
  const map = new Map<string, Trail>();
  for (const [id, trail] of Object.entries(fixtureTrailsById)) {
    map.set(id, { ...trail });
  }
  return map;
}

let trailsById = seedTrails();

export function searchTrails(query?: string, region?: string): TrailSummary[] {
  return [...trailsById.values()]
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))
    .filter((t) => !region || t.region === region)
    .map(({ id, name, region: r, distanceMeters, elevationGainMeters, dataSource }) => ({
      id,
      name,
      region: r,
      distanceMeters,
      elevationGainMeters,
      dataSource,
    }));
}

export function getTrailById(id: string): Trail | null {
  return trailsById.get(id) ?? null;
}

export function getTrailVersion(id: string): number | null {
  return trailsById.get(id)?.version ?? null;
}

/**
 * Stands in for whatever real event would bump a trail's official version —
 * a re-survey, a corrected route line, new waypoints. Lets the update-check
 * flow be exercised end to end without a real content pipeline existing yet.
 */
export function bumpTrailVersion(id: string): number | null {
  const trail = trailsById.get(id);
  if (!trail) return null;
  const updated: Trail = { ...trail, version: trail.version + 1 };
  trailsById.set(id, updated);
  return updated.version;
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  trailsById = seedTrails();
}
