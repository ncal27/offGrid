import {
  HazardConfidenceLevel,
  HazardReport,
  HazardReportAck,
  HazardReportStatus,
  HazardReportUpload,
  HazardSeverity,
  HazardType,
  HazardVote,
  HazardVoteAck,
  HazardVoteUpload,
  LatLng,
} from '@offgrid/shared';
import { getTrailById } from './trailService';
import { resolveWaypointId } from './waypointResolution';
import { haversineDistanceMeters } from '../geo';

/**
 * Hazard verification, modelled on how Waze handles road reports and adapted
 * for hikers who are usually offline.
 *
 * Waze's model (from its help pages): reports appear on the map, passing
 * drivers are asked "Still there?", and their answers lengthen ("Still
 * there") or shorten ("Not there") how long a report stays up, depending on
 * how many people react and on the report type. Waze doesn't publish exact
 * numbers, so every number below is ours, picked as a reasonable default
 * (docs/HAZARD_VERIFICATION.md walks through them). Tune them with real data.
 *
 * HOW IT WORKS
 * Reports about the same thing (same trail, same hazard type, within
 * CLUSTER_RADIUS_METERS) are merged into one INCIDENT. Every hiker gets
 * exactly one voice per incident: their latest report / "still there" /
 * "not there". An incident's confidence is
 *
 *     confidence = Σ weight(still there) − Σ weight(not there)
 *     weight     = proximity × reporter trust × decay
 *
 *  - proximity: 1.0 if the hiker's GPS put them within VOTE_NEAR_METERS of the
 *    hazard; 0.5 with no/weak GPS or from a bit further away (we can't
 *    confirm they were there); refused beyond VOTE_MAX_METERS.
 *  - trust: per-hiker reputation in [TRUST_MIN, TRUST_MAX], starting at 1.0.
 *    Goes up when other hikers independently confirm your reports, down when
 *    a reviewer rejects a hazard you vouched for.
 *  - decay: halves every HALF_LIFE_HOURS[hazardType], measured from when the
 *    hiker SAW it (observedAt), not when their phone synced. Flooding goes
 *    stale in a day; a collapsed bridge doesn't.
 *
 * The incident is SHARED (shipped in trip packages as 'verified') once at
 * least MIN_DISTINCT_CONFIRMATIONS different hikers back it AND confidence ≥
 * SHARE_THRESHOLD[severity]. The consensus rule applies to every severity,
 * impassable included: the team chose "never one person's word" over
 * showing severe hazards instantly (ROADMAP.md, 2026-11-19).
 * Confidence ≤ 0 with at least one "not there" means RESOLVED. If nobody has
 * confirmed it for EXPIRE_AFTER_HALF_LIVES half-lives it's EXPIRED.
 *
 * Reviewers can verify (adds a strong vote that still decays and can still
 * be outvoted on the ground), resolve, or reject (permanent, and costs the
 * people who vouched for it some trust).
 *
 * LIMITS (be honest about these): reporter IDs are self-asserted until real
 * accounts exist, so someone can invent fresh IDs at the default trust. The
 * per-IP rate limit in app.ts is the actual bound on that today, and
 * reputation only becomes meaningful with real auth (roadmap item 10).
 */

// ---- Tunable policy -------------------------------------------------------

export const CLUSTER_RADIUS_METERS = 75;
export const VOTE_NEAR_METERS = 150;
export const VOTE_MAX_METERS = 500;
const WEIGHT_NEAR = 1.0;
const WEIGHT_UNVERIFIED_POSITION = 0.5;

/**
 * Consensus rule (team decision 2026-11-19, see ROADMAP.md): no hazard is
 * shown to other hikers until at least this many DIFFERENT hikers have
 * reported it or said "still there". This applies to every severity,
 * including impassable, so one person can never put a hazard on everyone's
 * map. A reviewer's verification stands in for it.
 */
export const MIN_DISTINCT_CONFIRMATIONS = 3;

/**
 * On top of the head count, confidence (which accounts for GPS proximity,
 * trust and age) must clear this. Three on-the-spot hikers give 3.0, which
 * stays above 1.5 for one half-life (~1 week for a downed tree, ~1 day for
 * flooding) unless re-confirmed. Three hikers WITHOUT GPS only give 1.5, so
 * they're shared only briefly; at least one GPS confirmation helps a lot.
 * The per-severity table is kept so it can be tuned separately later; it is
 * uniform for now because the team chose consensus over speed for severe
 * hazards.
 */
export const SHARE_THRESHOLD: Record<HazardSeverity, number> = {
  minor: 1.5,
  moderate: 1.5,
  severe: 1.5,
  impassable: 1.5,
};

export const HALF_LIFE_HOURS: Record<HazardType, number> = {
  flooding: 24,
  other: 72,
  downed_tree: 7 * 24,
  washout: 14 * 24,
  bridge_out: 30 * 24,
};
const EXPIRE_AFTER_HALF_LIVES = 3;

export const TRUST_DEFAULT = 1.0;
export const TRUST_MIN = 0.25;
export const TRUST_MAX = 1.5;
const TRUST_REWARD_CONFIRMED = 0.1;
const TRUST_PENALTY_REJECTED = 0.3;

const REVIEWER_VOTER_ID = '__reviewer__';
const REVIEWER_WEIGHT = 4.0;

// Volume caps (same reasoning as contributionService).
const MAX_OPEN_INCIDENTS_PER_TRAIL = 500;
const MAX_OPEN_INCIDENTS_CREATED_PER_REPORTER_PER_TRAIL = 20;
/** Circuit breaker: never ship more than this many hazards for one trail. Highest confidence wins. */
const MAX_SHARED_HAZARDS_PER_TRAIL = 200;
const MAX_REMEMBERED_SUBMISSIONS = 50_000;

const HOUR_MS = 60 * 60 * 1000;

// ---- State ----------------------------------------------------------------

type VoteKind = 'report' | HazardVote;

interface StoredVote {
  submissionId: string;
  voterId: string;
  kind: VoteKind;
  observedAt: number;
  proximityWeight: number;
  /**
   * The voter's trust when they voted. Snapshotted so a reputation change
   * earned BECAUSE of this incident (e.g. the reward for being confirmed)
   * doesn't retroactively inflate this incident's own score.
   */
  trust: number;
  /** Only on 'report' votes: what this hiker said the severity was. */
  severity?: HazardSeverity;
}

interface Incident {
  id: string;
  trailId: string;
  hazardType: HazardType;
  waypointId?: string;
  /** Where the hazard is; votes are proximity-checked against this. Absent if no report had a position. */
  anchor?: LatLng;
  description?: string;
  createdBy: string;
  createdAt: number;
  /** One entry per voter: their latest vote wins. */
  votes: Map<string, StoredVote>;
  reviewerAction?: 'resolved' | 'rejected';
  /** Whether the creator has already been rewarded for this incident being confirmed by others. */
  creatorRewarded: boolean;
}

const incidents = new Map<string, Incident>();
const trustByHiker = new Map<string, number>();

/**
 * Idempotency/ownership for both reports and votes, keyed by the client's
 * submission id (BUG-007). Same id + same owner = safe retry, different owner
 * = conflict.
 */
type AnyAck = HazardReportAck | HazardVoteAck;
const submissions = new Map<string, { ownerId: string; ack: AnyAck }>();

export type SubmissionIdCheck<A extends AnyAck = AnyAck> =
  | { kind: 'new' }
  | { kind: 'duplicate'; ack: A }
  | { kind: 'conflict' };

export function checkSubmissionId<A extends AnyAck = HazardReportAck>(id: string, ownerId: string): SubmissionIdCheck<A> {
  const previous = submissions.get(id);
  if (!previous) return { kind: 'new' };
  if (previous.ownerId !== ownerId) return { kind: 'conflict' };
  return { kind: 'duplicate', ack: previous.ack as A };
}

function rememberSubmission(id: string, ownerId: string, ack: AnyAck): void {
  if (submissions.size >= MAX_REMEMBERED_SUBMISSIONS) {
    const oldest = submissions.keys().next().value;
    if (oldest !== undefined) submissions.delete(oldest);
  }
  submissions.set(id, { ownerId, ack });
}

// ---- Trust ----------------------------------------------------------------

export function getTrust(hikerId: string): number {
  return trustByHiker.get(hikerId) ?? TRUST_DEFAULT;
}

function adjustTrust(hikerId: string, delta: number): void {
  if (hikerId === REVIEWER_VOTER_ID) return;
  const next = Math.min(TRUST_MAX, Math.max(TRUST_MIN, getTrust(hikerId) + delta));
  trustByHiker.set(hikerId, next);
}

// ---- Scoring --------------------------------------------------------------

function voteWeight(incident: Incident, vote: StoredVote, now: number): number {
  const trust = vote.trust;
  const ageHours = Math.max(0, now - vote.observedAt) / HOUR_MS;
  const decay = Math.pow(0.5, ageHours / HALF_LIFE_HOURS[incident.hazardType]);
  return vote.proximityWeight * trust * decay;
}

/**
 * Severity of an incident = the severity with the most (undecayed) report
 * weight behind it, ties going to the LESS severe option. One hiker
 * claiming "impassable" can't escalate a spot several others called
 * "moderate", and so can't drag the sharing threshold down on their own.
 */
function incidentSeverity(incident: Incident): HazardSeverity {
  const order: HazardSeverity[] = ['minor', 'moderate', 'severe', 'impassable'];
  const tally = new Map<HazardSeverity, number>();
  for (const v of incident.votes.values()) {
    if (v.kind !== 'report' || !v.severity) continue;
    tally.set(v.severity, (tally.get(v.severity) ?? 0) + v.proximityWeight * v.trust);
  }
  let best: HazardSeverity = 'moderate';
  let bestWeight = -1;
  for (const sev of order) {
    const w = tally.get(sev) ?? 0;
    if (w > bestWeight) {
      best = sev;
      bestWeight = w;
    }
  }
  return best;
}

export interface IncidentAssessment {
  status: HazardReportStatus;
  confidence: number;
  confidenceLevel: HazardConfidenceLevel;
  severity: HazardSeverity;
  threshold: number;
  confirmations: number;
  denials: number;
  lastConfirmedAt: number;
  expiresAt: number;
  verifiedBy: HazardReport['verifiedBy'];
}

function assess(incident: Incident, now: number): IncidentAssessment {
  let support = 0;
  let against = 0;
  let confirmations = 0;
  let denials = 0;
  let lastConfirmedAt = incident.createdAt;
  let reviewerVouched = false;
  for (const v of incident.votes.values()) {
    const w = voteWeight(incident, v, now);
    if (v.kind === 'not_there') {
      against += w;
      denials++;
    } else {
      support += w;
      if (v.voterId === REVIEWER_VOTER_ID) reviewerVouched = true;
      else confirmations++;
      lastConfirmedAt = Math.max(lastConfirmedAt, v.observedAt);
    }
  }

  const confidence = Math.round((support - against) * 1000) / 1000;
  const severity = incidentSeverity(incident);
  const threshold = SHARE_THRESHOLD[severity];
  const halfLifeMs = HALF_LIFE_HOURS[incident.hazardType] * HOUR_MS;

  // With one shared half-life per incident, the whole score decays as
  // confidence(t) = confidence(now) · 0.5^((t − now) / halfLife), so the moment
  // it crosses the threshold has a closed form.
  const expiresAt =
    confidence >= threshold ? now + halfLifeMs * Math.log2(confidence / threshold) : now;

  let status: HazardReportStatus;
  if (incident.reviewerAction) status = incident.reviewerAction;
  else if (confidence >= threshold && (confirmations >= MIN_DISTINCT_CONFIRMATIONS || reviewerVouched)) {
    status = 'verified';
  }
  else if (denials > 0 && confidence <= 0) status = 'resolved';
  else if (now - lastConfirmedAt > EXPIRE_AFTER_HALF_LIVES * halfLifeMs) status = 'expired';
  else status = 'pending_review';

  // low: barely above the bar (fading, or confirmed mostly without GPS)
  // medium: comfortably above it; high: well above it AND 5+ hikers.
  const confidenceLevel: HazardConfidenceLevel =
    confirmations >= 5 && confidence >= 2 * threshold
      ? 'high'
      : confidence >= 2 * threshold
        ? 'medium'
        : 'low';

  const verifiedBy: HazardReport['verifiedBy'] = reviewerVouched ? 'reviewer' : 'community';

  return { status, confidence, confidenceLevel, severity, threshold, confirmations, denials, lastConfirmedAt, expiresAt, verifiedBy };
}

/** Rewards an incident's creator the first time other hikers independently confirm it. */
function settleRewards(incident: Incident, a: IncidentAssessment): void {
  if (incident.creatorRewarded || a.status !== 'verified') return;
  const othersConfirming = [...incident.votes.values()].some(
    (v) => v.kind !== 'not_there' && v.voterId !== incident.createdBy && v.voterId !== REVIEWER_VOTER_ID,
  );
  if (othersConfirming) {
    adjustTrust(incident.createdBy, TRUST_REWARD_CONFIRMED);
    incident.creatorRewarded = true;
  }
}

// ---- Geometry helpers -----------------------------------------------------

function waypointLocation(trailId: string, waypointId: string | undefined): LatLng | undefined {
  if (!waypointId) return undefined;
  return getTrailById(trailId)?.waypoints.find((wp) => wp.id === waypointId)?.location;
}

/** Proximity weight for a vote, or null if the hiker was demonstrably too far away to know. */
function proximityWeight(
  anchor: LatLng | undefined,
  location: LatLng | undefined,
  gpsWeakOrMissing: boolean,
): number | null {
  if (!anchor || !location || gpsWeakOrMissing) return WEIGHT_UNVERIFIED_POSITION;
  const d = haversineDistanceMeters(anchor, location);
  if (d <= VOTE_NEAR_METERS) return WEIGHT_NEAR;
  if (d <= VOTE_MAX_METERS) return WEIGHT_UNVERIFIED_POSITION;
  return null;
}

function isOpen(incident: Incident, now: number): boolean {
  if (incident.reviewerAction) return false;
  const s = assess(incident, now).status;
  return s === 'verified' || s === 'pending_review';
}

/**
 * Finds an open incident this report is about: same trail and hazard type,
 * within CLUSTER_RADIUS_METERS. A report with no position at all never
 * merges (merging position-less reports is exactly BUG-014).
 */
function findMatchingIncident(
  trailId: string,
  hazardType: HazardType,
  position: LatLng | undefined,
  now: number,
): Incident | undefined {
  if (!position) return undefined;
  let best: Incident | undefined;
  let bestDist = Infinity;
  for (const inc of incidents.values()) {
    if (inc.trailId !== trailId || inc.hazardType !== hazardType || !inc.anchor) continue;
    if (!isOpen(inc, now)) continue;
    const d = haversineDistanceMeters(position, inc.anchor);
    if (d <= CLUSTER_RADIUS_METERS && d < bestDist) {
      best = inc;
      bestDist = d;
    }
  }
  return best;
}

/** Keeps a hiker's latest-observed vote only, so replaying an old vote can't override a newer one. */
function recordVote(incident: Incident, vote: StoredVote): void {
  const existing = incident.votes.get(vote.voterId);
  if (existing && existing.observedAt > vote.observedAt) return;
  incident.votes.set(vote.voterId, vote);
}

// ---- Public API: reports --------------------------------------------------

export function canAcceptMoreHazardReports(trailId: string, reporterId: string, now = Date.now()): boolean {
  const open = [...incidents.values()].filter((i) => i.trailId === trailId && isOpen(i, now));
  if (open.length >= MAX_OPEN_INCIDENTS_PER_TRAIL) return false;
  const created = open.filter((i) => i.createdBy === reporterId);
  return created.length < MAX_OPEN_INCIDENTS_CREATED_PER_REPORTER_PER_TRAIL;
}

function ackMessage(a: IncidentAssessment, merged: boolean): string {
  if (a.status === 'verified') {
    return `Shared with other hikers (${a.confirmations} hikers confirmed it).`;
  }
  return merged
    ? 'Thanks. Added as a confirmation of a hazard other hikers already reported here.'
    : `Received. It will be shared with other hikers once ${MIN_DISTINCT_CONFIRMATIONS} hikers have confirmed it.`;
}

/**
 * Callers must have already run checkSubmissionId() (and handled duplicate or
 * conflict) and canAcceptMoreHazardReports(). The route does both.
 */
export function submitHazardReport(upload: HazardReportUpload, now = Date.now()): HazardReportAck {
  const waypointId = resolveWaypointId(upload);
  const position = upload.location ?? waypointLocation(upload.trailId, waypointId);
  const existing = findMatchingIncident(upload.trailId, upload.hazardType, position, now);

  const incident: Incident = existing ?? {
    id: `hz-${upload.id}`,
    trailId: upload.trailId,
    hazardType: upload.hazardType,
    waypointId,
    anchor: position,
    description: upload.description,
    createdBy: upload.reporterId,
    createdAt: Math.min(now, Date.parse(upload.reportedAt)),
    votes: new Map(),
    creatorRewarded: false,
  };
  if (!existing) incidents.set(incident.id, incident);

  // A report is also an implicit "still there" from its reporter. Merging
  // means a second reporter confirms the first, like a Waze "thumbs up".
  recordVote(incident, {
    submissionId: upload.id,
    voterId: upload.reporterId,
    kind: 'report',
    observedAt: Math.min(now, Date.parse(upload.reportedAt)),
    proximityWeight: proximityWeight(incident.anchor, upload.location, upload.gpsWeakOrMissing) ?? WEIGHT_UNVERIFIED_POSITION,
    trust: getTrust(upload.reporterId),
    severity: upload.severity,
  });

  const a = assess(incident, now);
  settleRewards(incident, a);
  const shared = isShared(incident, now);
  const ack: HazardReportAck = {
    id: upload.id,
    incidentId: incident.id,
    status: a.status === 'verified' && !shared ? 'pending_review' : a.status,
    confidence: a.confidence,
    message:
      a.status === 'verified' && !shared
        ? 'Received. This trail already has an unusually high number of active hazards, so this one needs human review before it is shared.'
        : ackMessage(a, !!existing),
  };
  rememberSubmission(upload.id, upload.reporterId, ack);
  return ack;
}

// ---- Public API: "still there?" votes -------------------------------------

export type VoteResult =
  | { ok: true; ack: HazardVoteAck }
  | { ok: false; reason: 'not_found' | 'closed' | 'too_far' };

export function submitHazardVote(upload: HazardVoteUpload, now = Date.now()): VoteResult {
  const incident = incidents.get(upload.incidentId);
  if (!incident || incident.trailId !== upload.trailId) return { ok: false, reason: 'not_found' };
  if (incident.reviewerAction) return { ok: false, reason: 'closed' };

  const weight = proximityWeight(incident.anchor, upload.location, upload.gpsWeakOrMissing);
  if (weight === null) return { ok: false, reason: 'too_far' };

  recordVote(incident, {
    submissionId: upload.id,
    voterId: upload.voterId,
    kind: upload.vote,
    observedAt: Math.min(now, Date.parse(upload.observedAt)),
    proximityWeight: weight,
    trust: getTrust(upload.voterId),
  });

  const a = assess(incident, now);
  settleRewards(incident, a);
  const ack: HazardVoteAck = {
    id: upload.id,
    incidentId: incident.id,
    status: a.status,
    confidence: a.confidence,
    message: upload.vote === 'not_there' ? 'Thanks. Marked as possibly cleared.' : 'Thanks for confirming.',
  };
  rememberSubmission(upload.id, upload.voterId, ack);
  return { ok: true, ack };
}

// ---- Public API: reviewers ------------------------------------------------

export type ReviewerAction = 'verify' | 'resolve' | 'reject';

export function reviewIncident(incidentId: string, action: ReviewerAction, now = Date.now()): IncidentAssessment | null {
  const incident = incidents.get(incidentId);
  if (!incident) return null;

  if (action === 'verify') {
    incident.reviewerAction = undefined;
    // A strong vote, not a permanent pin: it still decays, and hikers on the
    // ground can still outvote it if the hazard clears.
    incident.votes.set(REVIEWER_VOTER_ID, {
      submissionId: `review-${now}`,
      voterId: REVIEWER_VOTER_ID,
      kind: 'still_there',
      observedAt: now,
      proximityWeight: REVIEWER_WEIGHT,
      trust: 1,
    });
  } else if (action === 'resolve') {
    incident.reviewerAction = 'resolved';
  } else {
    if (incident.reviewerAction !== 'rejected') {
      for (const v of incident.votes.values()) {
        if (v.kind !== 'not_there') adjustTrust(v.voterId, -TRUST_PENALTY_REJECTED);
      }
    }
    incident.reviewerAction = 'rejected';
  }
  return assess(incident, now);
}

// ---- Public API: reading --------------------------------------------------

function toHazardReport(incident: Incident, a: IncidentAssessment): HazardReport {
  return {
    id: incident.id,
    trailId: incident.trailId,
    waypointId: incident.waypointId,
    hazardType: incident.hazardType,
    severity: a.severity,
    description: incident.description,
    reportedAt: new Date(incident.createdAt).toISOString(),
    status: 'verified',
    location: incident.anchor,
    confidence: a.confidence,
    confidenceLevel: a.confidenceLevel,
    confirmations: a.confirmations,
    denials: a.denials,
    lastConfirmedAt: new Date(a.lastConfirmedAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
    verifiedBy: a.verifiedBy,
  };
}

/** Hazards to ship in trip packages: currently verified, most confident first, capped per trail. */
export function getVerifiedHazardsForTrail(trailId: string, now = Date.now()): HazardReport[] {
  const out: HazardReport[] = [];
  for (const inc of incidents.values()) {
    if (inc.trailId !== trailId) continue;
    const a = assess(inc, now);
    if (a.status === 'verified') out.push(toHazardReport(inc, a));
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out.slice(0, MAX_SHARED_HAZARDS_PER_TRAIL);
}

function isShared(incident: Incident, now: number): boolean {
  return getVerifiedHazardsForTrail(incident.trailId, now).some((h) => h.id === incident.id);
}

export interface IncidentSummary extends IncidentAssessment {
  id: string;
  trailId: string;
  hazardType: HazardType;
  waypointId?: string;
}

/** For reviewers and tests: every incident on a trail with its current assessment. */
export function listIncidentsForTrail(trailId: string, now = Date.now()): IncidentSummary[] {
  return [...incidents.values()]
    .filter((i) => i.trailId === trailId)
    .map((i) => ({ id: i.id, trailId: i.trailId, hazardType: i.hazardType, waypointId: i.waypointId, ...assess(i, now) }));
}

/** Not-yet-shared incidents (kept for existing callers/tests). */
export function listPendingForTrail(trailId: string, now = Date.now()): IncidentSummary[] {
  return listIncidentsForTrail(trailId, now).filter((i) => i.status === 'pending_review');
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  incidents.clear();
  trustByHiker.clear();
  submissions.clear();
}
