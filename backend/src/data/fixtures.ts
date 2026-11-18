import { Trail, LandmarkPhoto } from '@offgrid/shared';

/**
 * Seed data standing in for a real official-source ingestion pipeline (USGS /
 * USFS / NPS data domestically, OpenStreetMap internationally — see
 * docs/architecture.md). One fictional trail is enough to exercise the full
 * plan -> download -> navigate -> photo-match -> contribute loop end to end.
 */
export const SHADOW_CREEK_TRAIL_ID = 'shadow-creek-loop';

const officialPhotos: LandmarkPhoto[] = [
  {
    id: 'scl-wp1-official-1',
    waypointId: 'scl-wp1',
    trailId: SHADOW_CREEK_TRAIL_ID,
    source: 'official',
    status: 'official',
    capturedAt: '2026-04-01T00:00:00.000Z',
    uri: 'official-assets/shadow-creek/wp1-creek-crossing.jpg',
    // Placeholder embedding standing in for real output from an on-device VPR
    // model (e.g. a HOGNet/MSGC-NetVLAD-style export) — see docs/architecture.md.
    embedding: Array.from({ length: 16 }, (_, i) => Math.sin(i + 1)),
  },
  {
    id: 'scl-wp2-official-1',
    waypointId: 'scl-wp2',
    trailId: SHADOW_CREEK_TRAIL_ID,
    source: 'official',
    status: 'official',
    capturedAt: '2026-04-01T00:00:00.000Z',
    uri: 'official-assets/shadow-creek/wp2-fork.jpg',
    embedding: Array.from({ length: 16 }, (_, i) => Math.cos(i + 1)),
  },
];

export const trailsById: Record<string, Trail> = {
  [SHADOW_CREEK_TRAIL_ID]: {
    id: SHADOW_CREEK_TRAIL_ID,
    name: 'Shadow Creek Loop',
    region: 'US-CA',
    distanceMeters: 8046,
    elevationGainMeters: 412,
    dataSource: 'usgs_usfs_nps',
    version: 1,
    routeLine: [
      { lat: 37.8651, lng: -119.5383 },
      { lat: 37.8659, lng: -119.5362 },
      { lat: 37.867, lng: -119.534 },
      { lat: 37.8688, lng: -119.5311 },
    ],
    waypoints: [
      {
        id: 'scl-wp1',
        trailId: SHADOW_CREEK_TRAIL_ID,
        location: { lat: 37.8659, lng: -119.5362 },
        distanceFromStartMeters: 1800,
        name: 'Creek crossing',
        description: 'Log bridge over Shadow Creek.',
      },
      {
        id: 'scl-wp2',
        trailId: SHADOW_CREEK_TRAIL_ID,
        location: { lat: 37.8688, lng: -119.5311 },
        distanceFromStartMeters: 4200,
        name: 'Trail fork',
        description: 'Left fork continues the loop; right fork is a spur to the overlook.',
      },
    ],
    elevationProfile: [
      { lat: 37.8651, lng: -119.5383, elevationMeters: 2210 },
      { lat: 37.8688, lng: -119.5311, elevationMeters: 2340 },
    ],
  },
};

export const photosByTrailId: Record<string, LandmarkPhoto[]> = {
  [SHADOW_CREEK_TRAIL_ID]: officialPhotos,
};
