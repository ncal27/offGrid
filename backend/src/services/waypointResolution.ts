import { LatLng } from '@offgrid/shared';
import { getTrailById } from './trailService';
import { haversineDistanceMeters } from '../geo';

/** How close a reported location must be to a waypoint to count as "at" it. */
export const WAYPOINT_DISTANCE_TOLERANCE_METERS = 50;

interface ResolvableUpload {
  trailId: string;
  waypointHintId?: string;
  location?: LatLng;
}

/**
 * Works out which waypoint a contribution or hazard report is about. Used by
 * both contributionService and hazardService (previously two copy-pasted
 * versions).
 *
 * Changed from "trust waypointHintId as-is" (BUG-006):
 *  - A hint only counts if that waypoint actually exists on the upload's
 *    trail. The route also rejects unknown hints up front; this is the second
 *    line of defense.
 *  - If the upload has BOTH a hint and a GPS location, and the location is
 *    more than the tolerance away from the hinted waypoint, the hint is
 *    ignored and the waypoint is resolved from the location instead. A client
 *    claiming "this is the creek crossing" from 5km away doesn't get to vote
 *    for the creek crossing.
 *  - A hint with no location is still accepted (GPS is often weak under
 *    canopy, which is the reason the hint exists). That remaining trust gap
 *    is tracked in docs/roadmap.md item 4.
 */
export function resolveWaypointId(upload: ResolvableUpload): string | undefined {
  const trail = getTrailById(upload.trailId);
  if (!trail) return undefined;

  if (upload.waypointHintId) {
    const hinted = trail.waypoints.find((wp) => wp.id === upload.waypointHintId);
    if (hinted) {
      if (!upload.location) return hinted.id;
      if (haversineDistanceMeters(upload.location, hinted.location) <= WAYPOINT_DISTANCE_TOLERANCE_METERS) {
        return hinted.id;
      }
      // Location contradicts the hint, so fall through and use the location.
    }
  }

  if (!upload.location) return undefined;

  let nearestId: string | undefined;
  let nearestDist = Infinity;
  for (const wp of trail.waypoints) {
    const d = haversineDistanceMeters(upload.location, wp.location);
    if (d < nearestDist) {
      nearestDist = d;
      nearestId = wp.id;
    }
  }
  return nearestDist <= WAYPOINT_DISTANCE_TOLERANCE_METERS ? nearestId : undefined;
}

export function waypointExistsOnTrail(trailId: string, waypointId: string): boolean {
  return !!getTrailById(trailId)?.waypoints.some((wp) => wp.id === waypointId);
}
