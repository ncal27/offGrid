import { HazardReport, LatLng, Trail } from '@offgrid/shared';

/**
 * Hazards from a downloaded package that should still be shown at time `at`.
 * Every shipped hazard has an `expiresAt` (when its confidence decays below
 * the sharing threshold if nobody re-confirms it), so the phone can retire
 * stale warnings on its own, with no signal, on a multi-day trip.
 */
export function activeHazards(hazards: HazardReport[], at: Date | string | number = Date.now()): HazardReport[] {
  const t = new Date(at).getTime();
  return hazards.filter((h) => {
    const expires = Date.parse(h.expiresAt);
    return h.status === 'verified' && Number.isFinite(expires) && expires > t;
  });
}

/** Where a hazard is: its own location, else its waypoint's. Undefined if neither is known. */
export function hazardPosition(hazard: HazardReport, trail: Trail): LatLng | undefined {
  if (hazard.location) return hazard.location;
  return trail.waypoints.find((wp) => wp.id === hazard.waypointId)?.location;
}

const TIER_NAMES: Record<HazardReport['confidenceLevel'], string> = {
  very_low: 'Very low confidence',
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

/** Short label a UI can show next to a hazard, e.g. "Very low confidence · 1 report". */
export function hazardConfidenceLabel(hazard: HazardReport): string {
  if (hazard.verifiedBy === 'reviewer') return 'Confirmed by a ranger/reviewer';
  const n = hazard.confirmations;
  return `${TIER_NAMES[hazard.confidenceLevel]} · ${n} ${n === 1 ? 'report' : 'hikers'}`;
}
