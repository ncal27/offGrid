/**
 * Shared domain types for OffGrid, used by both the backend API and the mobile
 * app's core logic. Keeping these in one package means a "trip package" built
 * by the backend and the one consumed on-device can never silently drift apart.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ElevationPoint extends LatLng {
  elevationMeters: number;
}

export interface Waypoint {
  id: string;
  trailId: string;
  location: LatLng;
  distanceFromStartMeters: number;
  name: string;
  description?: string;
}

/** Where a landmark photo came from. */
export type PhotoSource = 'official' | 'contributed';

/**
 * Lifecycle of a landmark photo. Only 'official' and 'promoted' photos are
 * ever shipped inside a downloadable TripPackage (see docs/roadmap.md for the
 * not-yet-built promotion pipeline that turns 'pending_review' into 'promoted').
 */
export type PhotoStatus = 'official' | 'pending_review' | 'promoted' | 'rejected';

export interface LandmarkPhoto {
  id: string;
  waypointId: string;
  trailId: string;
  source: PhotoSource;
  status: PhotoStatus;
  capturedAt: string; // ISO timestamp
  /** Capture location; may be approximate/absent if GPS was weak when it was taken. */
  location?: LatLng;
  /** Local file URI on device, or storage key on the backend. */
  uri: string;
  /**
   * Precomputed feature embedding from the on-device/server-side visual place
   * recognition model. Absent until an embedding pipeline has processed the photo.
   */
  embedding?: number[];
  contributorId?: string;
}

export type TrailDataSource = 'usgs_usfs_nps' | 'openstreetmap' | 'hybrid';

export interface TrailSummary {
  id: string;
  name: string;
  /** e.g. 'US-CA' for domestic trails, or a region name for international ones. */
  region: string;
  distanceMeters: number;
  elevationGainMeters: number;
  dataSource: TrailDataSource;
}

export interface Trail extends TrailSummary {
  /** Ordered polyline describing the trail. */
  routeLine: LatLng[];
  waypoints: Waypoint[];
  elevationProfile: ElevationPoint[];
  /** Increments whenever the official trail data changes, so devices can tell a downloaded package is stale. */
  version: number;
}

/** Lightweight response for checking whether a downloaded package is stale, without fetching the full Trail. */
export interface TrailVersionInfo {
  trailId: string;
  version: number;
}

export interface MapTileBundleRef {
  /** How far the offline tile bundle extends beyond the route line, so users have margin if they wander off-trail. */
  bufferMeters: number;
  tileFormat: 'mbtiles' | 'pmtiles';
  uri: string;
}

/**
 * Declared as a runtime array (not just a union type) so request validation
 * can check an incoming value against the allowed set at runtime — a plain
 * TypeScript union type only constrains code at compile time, not whatever a
 * client actually sends over the wire.
 */
export const HAZARD_TYPES = ['washout', 'downed_tree', 'flooding', 'bridge_out', 'other'] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];

export const HAZARD_SEVERITIES = ['minor', 'moderate', 'severe', 'impassable'] as const;
export type HazardSeverity = (typeof HAZARD_SEVERITIES)[number];

export type HazardReportStatus = 'pending_review' | 'verified' | 'resolved' | 'rejected';

/** A hiker-submitted trail-condition report, queued locally until the device reconnects (same shape as ContributedPhotoUpload). */
export interface HazardReportUpload {
  id: string;
  trailId: string;
  waypointHintId?: string;
  hazardType: HazardType;
  severity: HazardSeverity;
  description?: string;
  reportedAt: string;
  location?: LatLng;
  gpsWeakOrMissing: boolean;
  reporterId: string;
}

export interface HazardReportAck {
  id: string;
  status: HazardReportStatus;
  message: string;
}

/** A hazard report that's been verified (by corroboration or review) and is safe to ship in a TripPackage. */
export interface HazardReport {
  id: string;
  trailId: string;
  waypointId?: string;
  hazardType: HazardType;
  severity: HazardSeverity;
  description?: string;
  reportedAt: string;
  status: HazardReportStatus;
  location?: LatLng;
}

/** The complete, self-contained bundle a device downloads before going offline. */
export interface TripPackage {
  trailId: string;
  trailVersion: number;
  generatedAt: string;
  trail: Trail;
  mapTiles: MapTileBundleRef;
  /** Only official/promoted photos ship here — see PhotoStatus. */
  landmarkPhotos: LandmarkPhoto[];
  /** Only 'verified' hazard reports ship here — see HazardReportStatus. */
  hazards: HazardReport[];
}

export interface GpsFix {
  location: LatLng;
  accuracyMeters: number;
  timestamp: string;
}

export type NavigationEventType = 'on_route' | 'off_route' | 'approaching_waypoint' | 'reached_waypoint';

export interface NavigationEvent {
  type: NavigationEventType;
  fix: GpsFix;
  nearestWaypointId?: string;
  distanceFromRouteMeters: number;
}

export interface PhotoMatchCandidate {
  waypointId: string;
  photoId: string;
  /** Cosine similarity between the captured photo's embedding and this reference photo's embedding, 0..1. */
  similarity: number;
}

export interface PhotoMatchResult {
  matched: boolean;
  confidence: number;
  bestCandidate?: PhotoMatchCandidate;
  candidates: PhotoMatchCandidate[];
}

/** A hiker-contributed landmark photo, queued locally until the device reconnects. */
export interface ContributedPhotoUpload {
  id: string;
  trailId: string;
  /** Nearest known waypoint at capture time, if the app could determine one. */
  waypointHintId?: string;
  capturedAt: string;
  location?: LatLng;
  gpsWeakOrMissing: boolean;
  /** V1 transport encoding for the stub upload endpoint; a real build would use multipart/binary upload. */
  imageBase64: string;
  contributorId: string;
}

export interface ContributionAck {
  id: string;
  status: PhotoStatus;
  message: string;
}
