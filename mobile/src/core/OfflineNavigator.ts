import { GpsFix, NavigationEvent, Trail } from '@offgrid/shared';
import { distanceToPolylineMeters, haversineDistanceMeters } from './geo';

export interface OfflineNavigatorOptions {
  /** Perpendicular distance from the route line beyond which a fix counts as off-route. Default 50m. */
  offRouteThresholdMeters?: number;
  /** Distance to a waypoint at which to emit 'approaching_waypoint'. Default 100m. */
  waypointApproachThresholdMeters?: number;
  /** Distance to a waypoint at which to emit 'reached_waypoint' (fires once per waypoint). Default 20m. */
  waypointReachedThresholdMeters?: number;
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

  constructor(private trail: Trail, options: OfflineNavigatorOptions = {}) {
    this.offRouteThreshold = options.offRouteThresholdMeters ?? 50;
    this.approachThreshold = options.waypointApproachThresholdMeters ?? 100;
    this.reachedThreshold = options.waypointReachedThresholdMeters ?? 20;
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

    return events;
  }
}
