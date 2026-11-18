import { HazardReport, HazardReportAck, HazardReportUpload } from '@offgrid/shared';
import { resolveWaypointId } from './waypointResolution';

/**
 * V2 MVP for roadmap item 7 (hazard/wash-out layer). Deliberately reuses the
 * same "unverified until corroborated or reviewed" shape as
 * contributionService's landmark photo pipeline, and inherits the same
 * open trust/abuse limitations documented there (docs/roadmap.md item 8) —
 * this is not a finished trust model.
 *
 * One addition specific to hazards: a report marked 'impassable' severity is
 * verified immediately from a single report, without waiting for
 * corroboration. The reasoning is asymmetric risk — warning hikers about a
 * washed-out bridge that turns out to be fine costs little, while waiting
 * for a second report before warning about one that's real could matter a
 * lot more. This also makes the single-report path meaningfully easier to
 * abuse (one bad report instantly "verifies" a false hazard), which is
 * flagged as unresolved in docs/roadmap.md rather than solved here.
 */
const PROMOTION_MIN_DISTINCT_REPORTERS = 2;
const TIME_WINDOW_MS = 1000 * 60 * 60 * 24 * 14; // ~14 days — hazards go stale much faster than landmarks do

// Same blunt volume-cap reasoning as contributionService.ts.
const MAX_PENDING_PER_TRAIL = 500;
const MAX_PENDING_PER_REPORTER_PER_TRAIL = 20;

/**
 * The 'impassable' urgent path (see below) verifies a report immediately,
 * without ever sitting in `pendingReports` — so the pending-queue caps above
 * do nothing to stop a single reporter from flooding `verifiedHazardsByTrailId`
 * (which ships in every future package) by submitting many distinct urgent
 * reports. This is the backstop for that: once a trail has an unusually high
 * number of verified hazards, auto-verification (urgent or corroborated)
 * stops and everything falls back to pending_review, forcing human review
 * before the list grows further.
 */
const MAX_VERIFIED_HAZARDS_PER_TRAIL = 200;

const pendingReports = new Map<string, HazardReportUpload>();
const verifiedHazardsByTrailId = new Map<string, HazardReport[]>();

/**
 * Same idempotency/ownership record as contributionService's `submissions`.
 * Without it, a retried 'impassable' report (the mobile queue retries
 * whenever a response is lost) was verified a second time, shipping a
 * duplicate hazard in every package (BUG-007).
 */
const MAX_REMEMBERED_SUBMISSIONS = 50_000;
const submissions = new Map<string, { reporterId: string; ack: HazardReportAck }>();

export type SubmissionIdCheck =
  | { kind: 'new' }
  | { kind: 'duplicate'; ack: HazardReportAck }
  | { kind: 'conflict' };

export function checkSubmissionId(id: string, reporterId: string): SubmissionIdCheck {
  const previous = submissions.get(id);
  if (!previous) return { kind: 'new' };
  if (previous.reporterId !== reporterId) return { kind: 'conflict' };
  return { kind: 'duplicate', ack: previous.ack };
}

function rememberSubmission(upload: HazardReportUpload, ack: HazardReportAck): void {
  if (submissions.size >= MAX_REMEMBERED_SUBMISSIONS) {
    const oldest = submissions.keys().next().value;
    if (oldest !== undefined) submissions.delete(oldest);
  }
  submissions.set(upload.id, { reporterId: upload.reporterId, ack });
}

/** Checked by the route before accepting a new report, so a flood of garbage can't grow this map without bound. */
export function canAcceptMoreHazardReports(trailId: string, reporterId: string): boolean {
  const trailPending = listPendingForTrail(trailId);
  if (trailPending.length >= MAX_PENDING_PER_TRAIL) return false;
  const fromReporter = trailPending.filter((r) => r.reporterId === reporterId);
  return fromReporter.length < MAX_PENDING_PER_REPORTER_PER_TRAIL;
}

/**
 * Reports only corroborate each other if both resolve to the SAME KNOWN
 * waypoint. Previously `waypointId` could be `undefined` on both sides, and
 * `undefined === undefined` meant any two reports of the same type with no
 * location and no hint "corroborated" each other, wherever they actually
 * were on the trail (BUG-014).
 */
function findCorroborators(
  trailId: string,
  waypointId: string | undefined,
  hazardType: string,
  aroundTime: Date,
): HazardReportUpload[] {
  if (waypointId === undefined) return [];
  return [...pendingReports.values()].filter((r) => {
    if (r.trailId !== trailId) return false;
    if (r.hazardType !== hazardType) return false;
    if (resolveWaypointId(r) !== waypointId) return false;
    const dt = Math.abs(new Date(r.reportedAt).getTime() - aroundTime.getTime());
    return dt <= TIME_WINDOW_MS;
  });
}

function verifyReport(upload: HazardReportUpload, waypointId: string | undefined): HazardReport {
  const hazard: HazardReport = {
    id: `verified-${upload.id}`,
    trailId: upload.trailId,
    waypointId,
    hazardType: upload.hazardType,
    severity: upload.severity,
    description: upload.description,
    reportedAt: upload.reportedAt,
    status: 'verified',
    location: upload.location,
  };
  const existing = verifiedHazardsByTrailId.get(upload.trailId) ?? [];
  verifiedHazardsByTrailId.set(upload.trailId, [...existing, hazard]);
  return hazard;
}

/**
 * Callers must have already run checkSubmissionId() (and handled duplicate or
 * conflict) and canAcceptMoreHazardReports(). The route does both.
 */
export function submitHazardReport(upload: HazardReportUpload): HazardReportAck {
  const ack = evaluate(upload);
  rememberSubmission(upload, ack);
  return ack;
}

function evaluate(upload: HazardReportUpload): HazardReportAck {
  pendingReports.set(upload.id, upload);

  const waypointId = resolveWaypointId(upload);
  const corroborators = findCorroborators(
    upload.trailId,
    waypointId,
    upload.hazardType,
    new Date(upload.reportedAt),
  );
  const distinctReporters = new Set(corroborators.map((c) => c.reporterId));
  const isUrgent = upload.severity === 'impassable';
  const wouldAutoVerify = isUrgent || distinctReporters.size >= PROMOTION_MIN_DISTINCT_REPORTERS;
  const circuitBreakerTripped = getVerifiedHazardsForTrail(upload.trailId).length >= MAX_VERIFIED_HAZARDS_PER_TRAIL;

  if (wouldAutoVerify && !circuitBreakerTripped) {
    verifyReport(upload, waypointId);
    for (const c of corroborators) pendingReports.delete(c.id);
    pendingReports.delete(upload.id);
    return {
      id: upload.id,
      status: 'verified',
      message: isUrgent
        ? 'Marked impassable — verified immediately given the severity; flagged for human confirmation.'
        : `Verified after ${distinctReporters.size} independent reports.`,
    };
  }

  return {
    id: upload.id,
    status: 'pending_review',
    message: wouldAutoVerify
      ? 'Received. This trail already has an unusually high number of verified hazards, so this report requires human review before it can be verified.'
      : 'Received. This hazard report is queued for review and is not yet part of the official trail package.',
  };
}

export function listPendingForTrail(trailId: string): HazardReportUpload[] {
  return [...pendingReports.values()].filter((r) => r.trailId === trailId);
}

export function getVerifiedHazardsForTrail(trailId: string): HazardReport[] {
  return verifiedHazardsByTrailId.get(trailId) ?? [];
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  pendingReports.clear();
  verifiedHazardsByTrailId.clear();
  submissions.clear();
}
