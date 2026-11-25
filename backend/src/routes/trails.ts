import { Router } from 'express';
import { isSafeId } from '@offgrid/shared';
import { addImportedTrail, getTrailById, getTrailVersion, searchTrails } from '../services/trailService';
import { importTrailByName } from '../services/osmImportService';
import { buildTripPackage } from '../services/packageService';

export const trailsRouter = Router();

const MAX_SEARCH_QUERY_LENGTH = 100;

/** Every '/:id' route rejects malformed IDs with a 400 before touching any service. */
trailsRouter.param('id', (req, res, next, id) => {
  if (!isSafeId(id)) {
    res.status(400).json({ error: 'invalid_trail_id' });
    return;
  }
  next();
});

trailsRouter.get('/search', (req, res) => {
  const { q, region } = req.query;
  // Arrays (?q=a&q=b) and objects (?q[x]=1) are ignored rather than crashing
  // .toLowerCase(); over-long queries are rejected.
  if (
    (typeof q === 'string' && q.length > MAX_SEARCH_QUERY_LENGTH) ||
    (typeof region === 'string' && region.length > MAX_SEARCH_QUERY_LENGTH)
  ) {
    res.status(400).json({ error: 'search_query_too_long' });
    return;
  }
  const results = searchTrails(
    typeof q === 'string' ? q : undefined,
    typeof region === 'string' ? region : undefined,
  );
  res.json(results);
});

/**
 * Live import from OpenStreetMap by trail name (class demo: "shout out a
 * trail"). Rate limited with the other write endpoints in app.ts.
 */
trailsRouter.post('/import', async (req, res, next) => {
  try {
    const result = await importTrailByName(req.body?.query, req.body?.near);
    if (!result.ok) {
      const map = {
        invalid_query: [400, 'invalid_trail_query'],
        invalid_near: [400, 'invalid_place'],
        place_not_found: [404, 'place_not_found'],
        not_found: [404, 'trail_not_found_in_openstreetmap'],
        upstream_error: [502, 'openstreetmap_unavailable'],
      } as const;
      const [status, error] = map[result.reason];
      res.status(status).json({ error });
      return;
    }
    const added = addImportedTrail(result.trail);
    if (!added.ok) {
      res.status(507).json({ error: 'too_many_imported_trails' });
      return;
    }
    const { id, name, region, distanceMeters, elevationGainMeters, dataSource } = added.trail;
    res.status(added.existed ? 200 : 201).json({ id, name, region, distanceMeters, elevationGainMeters, dataSource });
  } catch (err) {
    next(err);
  }
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
