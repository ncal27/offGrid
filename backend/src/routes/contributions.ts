import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ContributedPhotoUpload, isSafeId } from '@offgrid/shared';
import {
  canAcceptMoreContributions,
  manuallyPromote,
  manuallyReject,
  submitContribution,
} from '../services/contributionService';
import { validateContributedPhotoUploadBody } from '../validation/requestValidation';

export const contributionsRouter = Router();

contributionsRouter.post('/photos', (req, res) => {
  const result = validateContributedPhotoUploadBody(req.body);
  if (!result.valid || !result.value) {
    res.status(400).json({ error: 'invalid_request', details: result.errors });
    return;
  }
  const fields = result.value;

  if (!canAcceptMoreContributions(fields.trailId, fields.contributorId)) {
    res.status(429).json({ error: 'too_many_pending_contributions' });
    return;
  }

  const upload: ContributedPhotoUpload = {
    id: fields.id ?? uuidv4(),
    trailId: fields.trailId,
    waypointHintId: fields.waypointHintId,
    capturedAt: fields.capturedAt,
    location: fields.location,
    gpsWeakOrMissing: fields.gpsWeakOrMissing,
    imageBase64: fields.imageBase64,
    contributorId: fields.contributorId,
  };

  const ack = submitContribution(upload);
  res.status(202).json(ack);
});

/**
 * Human-review path (the "manual" half of the hybrid promotion model
 * described in docs/roadmap.md item 4). No auth/role-check exists yet since
 * there is no auth system at all in V1/V2 — this endpoint is a placeholder
 * for a future curator tool, not something safe to expose publicly as-is.
 */
contributionsRouter.post('/:id/promote', (req, res) => {
  if (!isSafeId(req.params.id)) {
    res.status(400).json({ error: 'invalid_contribution_id' });
    return;
  }
  const waypointId = typeof req.body?.waypointId === 'string' ? req.body.waypointId : undefined;
  if (waypointId !== undefined && !isSafeId(waypointId)) {
    res.status(400).json({ error: 'invalid_waypoint_id' });
    return;
  }
  const photo = manuallyPromote(req.params.id, waypointId);
  if (!photo) {
    res.status(404).json({ error: 'contribution_not_found_or_unresolved_waypoint' });
    return;
  }
  res.json({ promoted: true, photo });
});

contributionsRouter.post('/:id/reject', (req, res) => {
  const removed = manuallyReject(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'contribution_not_found' });
    return;
  }
  res.json({ rejected: true });
});
