import { Router } from 'express';
import { getTrailById, getTrailVersion, searchTrails } from '../services/trailService';
import { buildTripPackage } from '../services/packageService';

export const trailsRouter = Router();

trailsRouter.get('/search', (req, res) => {
  const { q, region } = req.query;
  const results = searchTrails(
    typeof q === 'string' ? q : undefined,
    typeof region === 'string' ? region : undefined,
  );
  res.json(results);
});

/**
 * Lightweight check for whether a device's already-downloaded trip package
 * is stale, without requiring a full trail-detail fetch. Registered before
 * '/:id' only for readability; Express would route this correctly either
 * way since '/:id/version' and '/:id' are different path shapes.
 */
trailsRouter.get('/:id/version', (req, res) => {
  const version = getTrailVersion(req.params.id);
  if (version === null) {
    res.status(404).json({ error: 'trail_not_found' });
    return;
  }
  res.json({ trailId: req.params.id, version });
});

trailsRouter.get('/:id', (req, res) => {
  const trail = getTrailById(req.params.id);
  if (!trail) {
    res.status(404).json({ error: 'trail_not_found' });
    return;
  }
  res.json(trail);
});

trailsRouter.post('/:id/package', (req, res) => {
  const pkg = buildTripPackage(req.params.id);
  if (!pkg) {
    res.status(404).json({ error: 'trail_not_found' });
    return;
  }
  res.json(pkg);
});
