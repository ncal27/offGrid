import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { HazardReportUpload } from '@offgrid/shared';
import { canAcceptMoreHazardReports, submitHazardReport } from '../services/hazardService';
import { validateHazardReportUploadBody } from '../validation/requestValidation';

export const hazardsRouter = Router();

hazardsRouter.post('/reports', (req, res) => {
  const result = validateHazardReportUploadBody(req.body);
  if (!result.valid || !result.value) {
    res.status(400).json({ error: 'invalid_request', details: result.errors });
    return;
  }
  const fields = result.value;

  if (!canAcceptMoreHazardReports(fields.trailId, fields.reporterId)) {
    res.status(429).json({ error: 'too_many_pending_hazard_reports' });
    return;
  }

  const upload: HazardReportUpload = {
    id: fields.id ?? uuidv4(),
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

  const ack = submitHazardReport(upload);
  res.status(202).json(ack);
});
