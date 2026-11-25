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

export type WaypointKind = 'trailhead' | 'summit' | 'viewpoint' | 'landmark' | 'junction' | 'point';

export interface Waypoint {
  id: string;
  trailId: string;
  location: LatLng;
  distanceFromStartMeters: number;
  name: string;
  description?: string;
  /** What kind of place this is, so the app can show a fitting icon. */
  kind?: WaypointKind;
}

/** A side trail / fork connecting to the main route (e.g. the paths around Great Blue Hill). */
export interface TrailBranch {
  id: string;
  name: string;
  line: LatLng[];
}

export const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/** Credit for a photo we didn't take (e.g. Wikimedia Commons). Must be shown wherever the photo is. */
export interface PhotoAttribution {
  author: string;
  license: string;
  licenseUrl?: string;
  /** Page the photo came from (e.g. its Wikimedia Commons file page). */
  sourceUrl: string;
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
  /** Season the photo was taken in (from its capture date), for the season filter. */
  season?: Season;
  /** Smaller version of the image for lists. */
  thumbnailUrl?: string;
  title?: string;
  attribution?: PhotoAttribution;
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
  /** Ordered polyline describing the main route. */
  routeLine: LatLng[];
  /** Side trails and forks off the main route. Hikers on these are still "on trail". */
  branches?: TrailBranch[];
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

/**
 * - pending_review: known to the server, not shared yet (not enough confidence)
 * - verified: confident enough to ship in trip packages
 * - resolved: hikers (or a reviewer) said it's gone
 * - expired: nobody has confirmed it recently enough; confidence decayed away
 * - rejected: a reviewer marked it false; never shared again
 */
export type HazardReportStatus = 'pending_review' | 'verified' | 'resolved' | 'expired' | 'rejected';

/** Waze-style answers to "Is this hazard still there?" */
export const HAZARD_VOTES = ['still_there', 'not_there'] as const;
export type HazardVote = (typeof HAZARD_VOTES)[number];

/** Roughly "how many hikers back this right now": very_low <3, low 3-<5, medium 5-<10, high 10+. */
export type HazardConfidenceLevel = 'very_low' | 'low' | 'medium' | 'high';

/** A hiker's answer to "still there?" for a hazard they passed, queued offline like a report. */
export interface HazardVoteUpload {
  id: string;
  incidentId: string;
  trailId: string;
  vote: HazardVote;
  /** When the hiker actually saw it (not when it synced), used for decay. */
  observedAt: string;
  location?: LatLng;
  gpsWeakOrMissing: boolean;
  voterId: string;
}

export interface HazardVoteAck {
  id: string;
  incidentId: string;
  status: HazardReportStatus;
  confidence: number;
  message: string;
}

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
  /** The hazard incident this report was merged into (a new one, or an existing one nearby). */
  incidentId?: string;
  confidence?: number;
}

/**
 * A hazard incident (one or more merged reports about the same thing) that is
 * confident enough to ship in a TripPackage. `id` is the incident id that
 * "still there / not there" votes refer to.
 */
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
  /** Decayed, weighted confidence score (see backend hazardService for the formula). */
  confidence: number;
  confidenceLevel: HazardConfidenceLevel;
  /** Distinct hikers who reported it or said it's still there. */
  confirmations: number;
  /** Distinct hikers who said it's not there. */
  denials: number;
  lastConfirmedAt: string;
  /** When it drops below the sharing threshold if nobody confirms it again. Devices hide it after this, even offline. */
  expiresAt: string;
  verifiedBy: 'community' | 'reviewer' | 'urgent_report';
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

export type NavigationEventType =
  | 'on_route'
  | 'off_route'
  | 'approaching_waypoint'
  | 'reached_waypoint'
  /** Near a downloaded hazard: the UI's cue to ask "Is this still there?" */
  | 'approaching_hazard';

export interface NavigationEvent {
  type: NavigationEventType;
  fix: GpsFix;
  nearestWaypointId?: string;
  distanceFromRouteMeters: number;
  /** Set on 'approaching_hazard'. */
  hazardId?: string;
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

export type TrailDifficulty = 'easy' | 'moderate' | 'hard';

/** A trail found by "hiking places near <town>" (not downloaded yet; plan it to import and download). */
export interface NearbyTrail {
  name: string;
  lengthMeters: number;
  /** From the town's centre to the nearest point of the trail. */
  distanceFromCenterMeters: number;
  /**
   * ESTIMATED from length plus OpenStreetMap difficulty tags (sac_scale,
   * rocky surfaces, steps) when present. No elevation data yet.
   */
  difficulty: TrailDifficulty;
  difficultyScore: number;
  /** Estimated hiking time in minutes (~2 mph, slower for harder trails). */
  estimatedMinutes: number;
  center: LatLng;
}
