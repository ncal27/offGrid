import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { ContributedPhotoUpload, isSafeId } from '@offgrid/shared';
import {
  checkContributionCapacity,
  checkSubmissionId,
  manuallyPromote,
  manuallyReject,
  submitContribution,
} from '../services/contributionService';
import { getTrailById } from '../services/trailService';
import { waypointExistsOnTrail } from '../services/waypointResolution';
import { validateContributedPhotoUploadBody } from '../validation/requestValidation';
import { requireReviewer } from '../middleware/requireReviewer';

export const contributionsRouter = Router();

/**
 * Express 4 does not catch errors thrown from async handlers: an unexpected
 * rejection would hang the request and log an unhandled rejection instead of
 * reaching the JSON error handler in app.ts. This wrapper forwards it.
 */
const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

contributionsRouter.post(
  '/photos',
  asyncRoute(async (req, res) => {
    const result = await validateContributedPhotoUploadBody(req.body);
    if (!result.valid || !result.value) {
      res.status(400).json({ error: 'invalid_request', details: result.errors });
      return;
    }
    const fields = result.value;

    // Referential checks: IDs that are well-formed but don't exist. Before,
    // any made-up trailId was accepted and stored (BUG-005), which also
    // sidestepped the per-trail cap, and any made-up waypointHintId could be
    // auto-promoted into the trail's photo set (BUG-006).
    if (!getTrailById(fields.trailId)) {
      res.status(404).json({ error: 'trail_not_found' });
      return;
    }
    if (fields.waypointHintId !== undefined && !waypointExistsOnTrail(fields.trailId, fields.waypointHintId)) {
      res.status(400).json({ error: 'invalid_request', details: ['waypointHintId is not a waypoint on this trail'] });
      return;
    }

    if (fields.id !== undefined) {
      const idCheck = checkSubmissionId(fields.id, fields.contributorId);
      if (idCheck.kind === 'conflict') {
        res.status(409).json({ error: 'submission_id_conflict' });
        return;
      }
      if (idCheck.kind === 'duplicate') {
        // Safe retry from the offline queue: same answer, no second copy.
        res.status(200).json(idCheck.ack);
        return;
      }
    }

    const capacity = checkContributionCapacity(fields.trailId, fields.contributorId);
    if (capacity === 'server_full') {
      res.status(503).json({ error: 'contribution_storage_full' });
      return;
    }
    if (capacity !== 'ok') {
      res.status(429).json({ error: 'too_many_pending_contributions' });
      return;
    }

    const upload: ContributedPhotoUpload = {
      id: fields.id ?? randomUUID(),
      trailId: fields.trailId,
      waypointHintId: fields.waypointHintId,
      capturedAt: fields.capturedAt,
      location: fields.location,
      gpsWeakOrMissing: fields.gpsWeakOrMissing,
      imageBase64: fields.imageBase64, // sanitized, re-encoded JPEG
      contributorId: fields.contributorId,
    };

    res.status(202).json(submitContribution(upload));
  }),
);

/**
 * Human-review path (the "manual" half of the hybrid promotion model in
 * docs/roadmap.md item 4). Requires the reviewer token, see
 * middleware/requireReviewer.ts.
 */
contributionsRouter.post('/:id/promote', requireReviewer, (req, res) => {
  if (!isSafeId(req.params.id)) {
    res.status(400).json({ error: 'invalid_contribution_id' });
    return;
  }
  const rawWaypointId: unknown = req.body?.waypointId;
  if (rawWaypointId !== undefined && !isSafeId(rawWaypointId)) {
    res.status(400).json({ error: 'invalid_waypoint_id' });
    return;
  }
  const result = manuallyPromote(req.params.id, rawWaypointId as string | undefined);
  if (!result.ok) {
    if (result.reason === 'waypoint_not_on_trail') {
      res.status(400).json({ error: 'waypoint_not_on_trail' });
    } else {
      res.status(404).json({ error: 'contribution_not_found_or_unresolved_waypoint' });
    }
    return;
  }
  res.json({ promoted: true, photo: result.photo });
});

contributionsRouter.post('/:id/reject', requireReviewer, (req, res) => {
  if (!isSafeId(req.params.id)) {
    res.status(400).json({ error: 'invalid_contribution_id' });
    return;
  }
  if (!manuallyReject(req.params.id)) {
    res.status(404).json({ error: 'contribution_not_found' });
    return;
  }
  res.json({ rejected: true });
});
