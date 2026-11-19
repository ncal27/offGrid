import { randomUUID } from 'crypto';
import { Router } from 'express';
import { HazardReportUpload, HazardVoteAck, isSafeId } from '@offgrid/shared';
import {
  canAcceptMoreHazardReports,
  checkSubmissionId,
  listIncidentsForTrail,
  reviewIncident,
  ReviewerAction,
  submitHazardReport,
  submitHazardVote,
} from '../services/hazardService';
import { getTrailById } from '../services/trailService';
import { waypointExistsOnTrail } from '../services/waypointResolution';
import { validateHazardReportUploadBody, validateHazardVoteBody } from '../validation/requestValidation';
import { requireReviewer } from '../middleware/requireReviewer';

export const hazardsRouter = Router();

hazardsRouter.post('/reports', (req, res) => {
  const result = validateHazardReportUploadBody(req.body);
  if (!result.valid || !result.value) {
    res.status(400).json({ error: 'invalid_request', details: result.errors });
    return;
  }
  const fields = result.value;

  // Same referential checks as contributions (BUG-005, BUG-006).
  if (!getTrailById(fields.trailId)) {
    res.status(404).json({ error: 'trail_not_found' });
    return;
  }
  if (fields.waypointHintId !== undefined && !waypointExistsOnTrail(fields.trailId, fields.waypointHintId)) {
    res.status(400).json({ error: 'invalid_request', details: ['waypointHintId is not a waypoint on this trail'] });
    return;
  }

  if (fields.id !== undefined) {
    const idCheck = checkSubmissionId(fields.id, fields.reporterId);
    if (idCheck.kind === 'conflict') {
      res.status(409).json({ error: 'submission_id_conflict' });
      return;
    }
    if (idCheck.kind === 'duplicate') {
      res.status(200).json(idCheck.ack);
      return;
    }
  }

  if (!canAcceptMoreHazardReports(fields.trailId, fields.reporterId)) {
    res.status(429).json({ error: 'too_many_pending_hazard_reports' });
    return;
  }

  const upload: HazardReportUpload = {
    id: fields.id ?? randomUUID(),
    trailId: fields.trailId,
    waypointHintId: fields.waypointHintId,
    hazardType: fields.hazardType,
    severity: fields.severity,
    description: fields.description,
    reportedAt: fields.reportedAt,
    location: fields.location,
    gpsWeakOrMissing: fields.gpsWeakOrMissing,
    reporterId: fields.reporterId,
  };

  res.status(202).json(submitHazardReport(upload));
});

/**
 * "Is this hazard still there?": a hiker's answer about an incident they
 * passed (usually queued offline on the phone and synced later). The `id` is
 * required so a resend after a lost response is a safe retry.
 */
hazardsRouter.post('/votes', (req, res) => {
  const result = validateHazardVoteBody(req.body);
  if (!result.valid || !result.value) {
    res.status(400).json({ error: 'invalid_request', details: result.errors });
    return;
  }
  const vote = result.value;

  const idCheck = checkSubmissionId<HazardVoteAck>(vote.id, vote.voterId);
  if (idCheck.kind === 'conflict') {
    res.status(409).json({ error: 'submission_id_conflict' });
    return;
  }
  if (idCheck.kind === 'duplicate') {
    res.status(200).json(idCheck.ack);
    return;
  }

  const outcome = submitHazardVote(vote);
  if (!outcome.ok) {
    const map = {
      not_found: [404, 'hazard_not_found'],
      closed: [409, 'hazard_closed'],
      too_far: [422, 'too_far_from_hazard'],
    } as const;
    const [status, error] = map[outcome.reason];
    res.status(status).json({ error });
    return;
  }
  res.status(202).json(outcome.ack);
});

// ---- Reviewer endpoints (require OFFGRID_REVIEWER_TOKEN) -------------------

hazardsRouter.get('/incidents', requireReviewer, (req, res) => {
  const trailId = req.query.trailId;
  if (!isSafeId(trailId)) {
    res.status(400).json({ error: 'invalid_trail_id' });
    return;
  }
  res.json(listIncidentsForTrail(trailId));
});

const reviewActions: Record<string, ReviewerAction> = { verify: 'verify', resolve: 'resolve', reject: 'reject' };

hazardsRouter.post('/:id/:action(verify|resolve|reject)', requireReviewer, (req, res) => {
  if (!isSafeId(req.params.id)) {
    res.status(400).json({ error: 'invalid_hazard_id' });
    return;
  }
  const result = reviewIncident(req.params.id, reviewActions[req.params.action]);
  if (!result) {
    res.status(404).json({ error: 'hazard_not_found' });
    return;
  }
  res.json({ id: req.params.id, status: result.status, confidence: result.confidence });
});
