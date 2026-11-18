import { ContributedPhotoUpload, ContributionAck, LandmarkPhoto } from '@offgrid/shared';
import { getTrailById } from './trailService';
import { addPromotedPhoto } from './landmarkPhotoService';
import { haversineDistanceMeters } from '../geo';

/**
 * V2: a first, intentionally blunt automated corroboration rule, plus a
 * manual override for human review. This is NOT the final trust/abuse
 * design (see docs/roadmap.md item 4 and item 8 for what's still open —
 * duplicate/blur detection, reputation, face-blurring, etc.) — it exists so
 * the "official sources first, crowdsourced aggregated later" promise from
 * the original product discussion has something real behind it.
 *
 * Trust assumption worth flagging: a contribution's `waypointHintId`, if
 * present, is trusted as-is rather than re-validated against `location`.
 * A malicious or buggy client could claim any waypoint. Tightening this is
 * part of the still-open abuse-prevention work in docs/roadmap.md item 8.
 */
const PROMOTION_MIN_DISTINCT_CONTRIBUTORS = 2;
const PROMOTION_DISTANCE_TOLERANCE_METERS = 50;
const PROMOTION_TIME_WINDOW_MS = 1000 * 60 * 60 * 24 * 180; // ~180 days

// Blunt volume caps — not real abuse detection, just a floor against one
// contributor (or one bug) filling up memory with an unbounded number of
// pending items. See docs/roadmap.md item 8 for the real defenses still needed.
const MAX_PENDING_PER_TRAIL = 500;
const MAX_PENDING_PER_CONTRIBUTOR_PER_TRAIL = 20;

const pendingContributions = new Map<string, ContributedPhotoUpload>();

/** Checked by the route before accepting a new submission, so a flood of garbage can't grow this map without bound. */
export function canAcceptMoreContributions(trailId: string, contributorId: string): boolean {
  const trailPending = listPendingForTrail(trailId);
  if (trailPending.length >= MAX_PENDING_PER_TRAIL) return false;
  const fromContributor = trailPending.filter((c) => c.contributorId === contributorId);
  return fromContributor.length < MAX_PENDING_PER_CONTRIBUTOR_PER_TRAIL;
}

function resolveWaypointId(upload: ContributedPhotoUpload): string | undefined {
  if (upload.waypointHintId) return upload.waypointHintId;
  if (!upload.location) return undefined;

  const trail = getTrailById(upload.trailId);
  if (!trail) return undefined;

  let nearestId: string | undefined;
  let nearestDist = Infinity;
  for (const wp of trail.waypoints) {
    const d = haversineDistanceMeters(upload.location, wp.location);
    if (d < nearestDist) {
      nearestDist = d;
      nearestId = wp.id;
    }
  }
  return nearestDist <= PROMOTION_DISTANCE_TOLERANCE_METERS ? nearestId : undefined;
}

function findCorroborators(trailId: string, waypointId: string, aroundTime: Date): ContributedPhotoUpload[] {
  return [...pendingContributions.values()].filter((c) => {
    if (c.trailId !== trailId) return false;
    if (resolveWaypointId(c) !== waypointId) return false;
    const dt = Math.abs(new Date(c.capturedAt).getTime() - aroundTime.getTime());
    return dt <= PROMOTION_TIME_WINDOW_MS;
  });
}

function promoteToLandmarkPhoto(upload: ContributedPhotoUpload, waypointId: string): LandmarkPhoto {
  const photo: LandmarkPhoto = {
    id: `promoted-${upload.id}`,
    waypointId,
    trailId: upload.trailId,
    source: 'contributed',
    status: 'promoted',
    capturedAt: upload.capturedAt,
    location: upload.location,
    uri: `contributed-assets/${upload.trailId}/${waypointId}/${upload.id}.jpg`,
    contributorId: upload.contributorId,
    // No embedding yet: real embedding generation for contributed photos is
    // still open work (docs/roadmap.md item 5). Until then, a promoted
    // photo ships inside a TripPackage but LandmarkMatcher can't match
    // against it (it filters to photos that already have an embedding).
  };
  addPromotedPhoto(photo);
  return photo;
}

export function submitContribution(upload: ContributedPhotoUpload): ContributionAck {
  pendingContributions.set(upload.id, upload);

  const waypointId = resolveWaypointId(upload);
  if (!waypointId) {
    return {
      id: upload.id,
      status: 'pending_review',
      message: 'Received. This photo is queued for review and is not yet part of the official trail package.',
    };
  }

  const corroborators = findCorroborators(upload.trailId, waypointId, new Date(upload.capturedAt));
  const distinctContributors = new Set(corroborators.map((c) => c.contributorId));

  if (distinctContributors.size >= PROMOTION_MIN_DISTINCT_CONTRIBUTORS) {
    promoteToLandmarkPhoto(upload, waypointId);
    for (const c of corroborators) pendingContributions.delete(c.id);
    return {
      id: upload.id,
      status: 'promoted',
      message: `Promoted automatically after ${distinctContributors.size} independent hikers confirmed this landmark.`,
    };
  }

  return {
    id: upload.id,
    status: 'pending_review',
    message: 'Received. This photo is queued for review and is not yet part of the official trail package.',
  };
}

export function listPendingForTrail(trailId: string): ContributedPhotoUpload[] {
  return [...pendingContributions.values()].filter((c) => c.trailId === trailId);
}

/** Human-review path: promote a specific pending contribution directly, optionally overriding which waypoint it belongs to. */
export function manuallyPromote(contributionId: string, waypointIdOverride?: string): LandmarkPhoto | null {
  const upload = pendingContributions.get(contributionId);
  if (!upload) return null;

  const waypointId = waypointIdOverride ?? resolveWaypointId(upload);
  if (!waypointId) return null;

  const photo = promoteToLandmarkPhoto(upload, waypointId);
  pendingContributions.delete(contributionId);
  return photo;
}

/** Human-review path: discard a pending contribution without promoting it. */
export function manuallyReject(contributionId: string): boolean {
  return pendingContributions.delete(contributionId);
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  pendingContributions.clear();
}
