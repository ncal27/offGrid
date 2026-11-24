import { ContributedPhotoUpload, ContributionAck, LandmarkPhoto, seasonOf } from '@offgrid/shared';
import { addPromotedPhoto } from './landmarkPhotoService';
import { resolveWaypointId, WAYPOINT_DISTANCE_TOLERANCE_METERS, waypointExistsOnTrail } from './waypointResolution';

/**
 * V2: a first, intentionally blunt automated corroboration rule, plus a
 * manual override for human review. This is NOT the final trust/abuse
 * design (see docs/roadmap.md items 4 and 8 for what's still open:
 * duplicate/blur detection, reputation, face-blurring, etc.).
 *
 * Waypoint resolution lives in waypointResolution.ts and no longer trusts
 * `waypointHintId` blindly (BUG-006). Contributor IDs are still
 * self-asserted (there is no auth), so per-contributor caps can be dodged by
 * inventing new IDs; the per-IP rate limiter in app.ts and the global caps
 * below are what actually bound abuse.
 */
const PROMOTION_MIN_DISTINCT_CONTRIBUTORS = 2;
export const PROMOTION_DISTANCE_TOLERANCE_METERS = WAYPOINT_DISTANCE_TOLERANCE_METERS;
const PROMOTION_TIME_WINDOW_MS = 1000 * 60 * 60 * 24 * 180; // ~180 days

// Volume caps. Not real abuse detection, just a ceiling so memory can't grow
// without bound. The trail cap only means something now that unknown trailIds
// are rejected (BUG-005); before that, inventing trailIds bypassed it.
const MAX_PENDING_PER_TRAIL = 500;
const MAX_PENDING_PER_CONTRIBUTOR_PER_TRAIL = 20;
/** Pending photos live in memory until a real object store exists; cap the total bytes held. */
const MAX_TOTAL_PENDING_IMAGE_BASE64_CHARS = 256 * 1024 * 1024;
/** Upper bound on how many submission IDs are remembered for idempotency. */
const MAX_REMEMBERED_SUBMISSIONS = 50_000;

const pendingContributions = new Map<string, ContributedPhotoUpload>();
let pendingImageChars = 0;

/**
 * Every submission ID ever accepted, with who sent it and what we told them.
 * Lets the mobile offline queue safely retry an upload whose response was
 * lost (same id + same contributor = same answer, no duplicate), and stops a
 * different client from reusing someone else's id to overwrite their pending
 * contribution (BUG-007).
 */
const submissions = new Map<string, { contributorId: string; ack: ContributionAck }>();

export type CapacityCheck = 'ok' | 'trail_full' | 'contributor_full' | 'server_full';

/** Checked by the route before accepting a new submission. */
export function checkContributionCapacity(trailId: string, contributorId: string): CapacityCheck {
  if (pendingImageChars >= MAX_TOTAL_PENDING_IMAGE_BASE64_CHARS) return 'server_full';
  const trailPending = listPendingForTrail(trailId);
  if (trailPending.length >= MAX_PENDING_PER_TRAIL) return 'trail_full';
  const fromContributor = trailPending.filter((c) => c.contributorId === contributorId);
  if (fromContributor.length >= MAX_PENDING_PER_CONTRIBUTOR_PER_TRAIL) return 'contributor_full';
  return 'ok';
}

/** Kept for backwards compatibility with existing callers. */
export function canAcceptMoreContributions(trailId: string, contributorId: string): boolean {
  return checkContributionCapacity(trailId, contributorId) === 'ok';
}

export type SubmissionIdCheck =
  | { kind: 'new' }
  | { kind: 'duplicate'; ack: ContributionAck }
  | { kind: 'conflict' };

export function checkSubmissionId(id: string, contributorId: string): SubmissionIdCheck {
  const previous = submissions.get(id);
  if (!previous) return { kind: 'new' };
  if (previous.contributorId !== contributorId) return { kind: 'conflict' };
  return { kind: 'duplicate', ack: previous.ack };
}

function rememberSubmission(upload: ContributedPhotoUpload, ack: ContributionAck): void {
  if (submissions.size >= MAX_REMEMBERED_SUBMISSIONS) {
    // Map iterates in insertion order, so this forgets the oldest.
    const oldest = submissions.keys().next().value;
    if (oldest !== undefined) submissions.delete(oldest);
  }
  submissions.set(upload.id, { contributorId: upload.contributorId, ack });
}

function addPending(upload: ContributedPhotoUpload): void {
  pendingContributions.set(upload.id, upload);
  pendingImageChars += upload.imageBase64.length;
}

function removePending(id: string): boolean {
  const existing = pendingContributions.get(id);
  if (!existing) return false;
  pendingImageChars -= existing.imageBase64.length;
  return pendingContributions.delete(id);
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
    // Served by GET /photos/:id.jpg (relative to the API). The id passed
    // isSafeId, so this can't be used for path traversal.
    uri: `/photos/promoted-${upload.id}.jpg`,
    thumbnailUrl: `/photos/promoted-${upload.id}.jpg`,
    season: seasonOf(new Date(upload.capturedAt)),
    title: 'Hiker photo',
    attribution: { author: 'An OffGrid hiker', license: 'Shared with OffGrid', sourceUrl: `/photos/promoted-${upload.id}.jpg` },
    contributorId: upload.contributorId,
    // No stored embedding: phones fingerprint reference photos themselves
    // after download (mobile/src/core/imageFingerprint.ts), so a promoted
    // photo becomes matchable as soon as it ships in a package.
  };
  // upload.imageBase64 is the sanitized, re-encoded JPEG (never client bytes).
  addPromotedPhoto(photo, Buffer.from(upload.imageBase64, 'base64'));
  return photo;
}

/**
 * Callers must have already run checkSubmissionId() (and handled duplicate or
 * conflict) and checkContributionCapacity(). The route does both.
 */
export function submitContribution(upload: ContributedPhotoUpload): ContributionAck {
  addPending(upload);
  const ack = evaluate(upload);
  rememberSubmission(upload, ack);
  return ack;
}

function evaluate(upload: ContributedPhotoUpload): ContributionAck {
  const pendingAck: ContributionAck = {
    id: upload.id,
    status: 'pending_review',
    message: 'Received. This photo is queued for review and is not yet part of the official trail package.',
  };

  const waypointId = resolveWaypointId(upload);
  if (!waypointId) return pendingAck;

  const corroborators = findCorroborators(upload.trailId, waypointId, new Date(upload.capturedAt));
  const distinctContributors = new Set(corroborators.map((c) => c.contributorId));

  if (distinctContributors.size >= PROMOTION_MIN_DISTINCT_CONTRIBUTORS) {
    promoteToLandmarkPhoto(upload, waypointId);
    for (const c of corroborators) removePending(c.id);
    return {
      id: upload.id,
      status: 'promoted',
      message: `Promoted automatically after ${distinctContributors.size} independent hikers confirmed this landmark.`,
    };
  }
  return pendingAck;
}

export function listPendingForTrail(trailId: string): ContributedPhotoUpload[] {
  return [...pendingContributions.values()].filter((c) => c.trailId === trailId);
}

export type ManualPromoteResult =
  | { ok: true; photo: LandmarkPhoto }
  | { ok: false; reason: 'not_found' | 'unresolved_waypoint' | 'waypoint_not_on_trail' };

/** Human-review path: promote a specific pending contribution directly, optionally overriding which waypoint it belongs to. */
export function manuallyPromote(contributionId: string, waypointIdOverride?: string): ManualPromoteResult {
  const upload = pendingContributions.get(contributionId);
  if (!upload) return { ok: false, reason: 'not_found' };

  if (waypointIdOverride !== undefined && !waypointExistsOnTrail(upload.trailId, waypointIdOverride)) {
    return { ok: false, reason: 'waypoint_not_on_trail' };
  }
  const waypointId = waypointIdOverride ?? resolveWaypointId(upload);
  if (!waypointId) return { ok: false, reason: 'unresolved_waypoint' };

  const photo = promoteToLandmarkPhoto(upload, waypointId);
  removePending(contributionId);
  return { ok: true, photo };
}

/** Human-review path: discard a pending contribution without promoting it. */
export function manuallyReject(contributionId: string): boolean {
  return removePending(contributionId);
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  pendingContributions.clear();
  submissions.clear();
  pendingImageChars = 0;
}
