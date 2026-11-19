import { GpsFix, HazardReport, LatLng, NavigationEvent, Trail } from '@offgrid/shared';
import { distanceToPolylineMeters, haversineDistanceMeters } from './geo';
import { activeHazards, hazardPosition } from './hazards';

export interface OfflineNavigatorOptions {
  /** Perpendicular distance from the route line beyond which a fix counts as off-route. Default 50m. */
  offRouteThresholdMeters?: number;
  /** Distance to a waypoint at which to emit 'approaching_waypoint'. Default 100m. */
  waypointApproachThresholdMeters?: number;
  /** Distance to a waypoint at which to emit 'reached_waypoint' (fires once per waypoint). Default 20m. */
  waypointReachedThresholdMeters?: number;
  /** Verified hazards from the downloaded TripPackage. */
  hazards?: HazardReport[];
  /**
   * Distance at which to emit 'approaching_hazard' (once per hazard), the
   * UI's cue to warn the hiker and ask "Is this still there?". Default 150m,
   * matching the backend's on-the-spot vote radius, so a hiker prompted here
   * gets full vote weight.
   */
  hazardPromptThresholdMeters?: number;
}

/**
 * Tracks a device's GPS fixes against a downloaded trail's route line and
 * waypoints, entirely offline (no network, no server calls — everything it
 * needs lives in the already-downloaded Trail). This is the core "am I on
 * the trail" logic; MapAdapter implementations render its output but don't
 * need to understand route-following themselves.
 */
export class OfflineNavigator {
  private offRouteThreshold: number;
  private approachThreshold: number;
  private reachedThreshold: number;
  private reachedWaypoints = new Set<string>();
  private promptedHazards = new Set<string>();
  private hazardPromptThreshold: number;
  private hazards: { hazard: HazardReport; position: LatLng }[];

  constructor(private trail: Trail, options: OfflineNavigatorOptions = {}) {
    this.offRouteThreshold = options.offRouteThresholdMeters ?? 50;
    this.approachThreshold = options.waypointApproachThresholdMeters ?? 100;
    this.reachedThreshold = options.waypointReachedThresholdMeters ?? 20;
    this.hazardPromptThreshold = options.hazardPromptThresholdMeters ?? 150;
    this.hazards = (options.hazards ?? []).flatMap((hazard) => {
      const position = hazardPosition(hazard, trail);
      return position ? [{ hazard, position }] : [];
    });
  }

  processFix(fix: GpsFix): NavigationEvent[] {
    const events: NavigationEvent[] = [];
    const { distanceMeters } = distanceToPolylineMeters(fix.location, this.trail.routeLine);

    let nearestWaypointId: string | undefined;
    let nearestWaypointDistance = Infinity;
    for (const wp of this.trail.waypoints) {
      const d = haversineDistanceMeters(fix.location, wp.location);
      if (d < nearestWaypointDistance) {
        nearestWaypointDistance = d;
        nearestWaypointId = wp.id;
      }
    }

    events.push({
      type: distanceMeters > this.offRouteThreshold ? 'off_route' : 'on_route',
      fix,
      nearestWaypointId,
      distanceFromRouteMeters: distanceMeters,
    });

    if (nearestWaypointId) {
      const alreadyReached = this.reachedWaypoints.has(nearestWaypointId);
      if (nearestWaypointDistance <= this.reachedThreshold && !alreadyReached) {
        this.reachedWaypoints.add(nearestWaypointId);
        events.push({
          type: 'reached_waypoint',
          fix,
          nearestWaypointId,
          distanceFromRouteMeters: distanceMeters,
        });
      } else if (nearestWaypointDistance <= this.approachThreshold && !alreadyReached) {
        events.push({
          type: 'approaching_waypoint',
          fix,
          nearestWaypointId,
          distanceFromRouteMeters: distanceMeters,
        });
      }
    }

    // Hazards: checked against the fix's own timestamp, so a warning that
    // expired mid-trip stops being shown even with no signal.
    const live = new Set(activeHazards(this.hazards.map((h) => h.hazard), fix.timestamp).map((h) => h.id));
    for (const { hazard, position } of this.hazards) {
      if (!live.has(hazard.id) || this.promptedHazards.has(hazard.id)) continue;
      if (haversineDistanceMeters(fix.location, position) <= this.hazardPromptThreshold) {
        this.promptedHazards.add(hazard.id);
        events.push({
          type: 'approaching_hazard',
          fix,
          hazardId: hazard.id,
          nearestWaypointId,
          distanceFromRouteMeters: distanceMeters,
        });
      }
    }

    return events;
  }
}
