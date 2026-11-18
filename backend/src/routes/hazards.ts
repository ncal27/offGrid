import { randomUUID } from 'crypto';
import { Router } from 'express';
import { HazardReportUpload } from '@offgrid/shared';
import { canAcceptMoreHazardReports, checkSubmissionId, submitHazardReport } from '../services/hazardService';
import { getTrailById } from '../services/trailService';
import { waypointExistsOnTrail } from '../services/waypointResolution';
import { validateHazardReportUploadBody } from '../validation/requestValidation';

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
