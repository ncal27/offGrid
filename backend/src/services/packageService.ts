import { TripPackage } from '@offgrid/shared';
import { getTrailById } from './trailService';
import { getShippablePhotosForTrail } from './landmarkPhotoService';
import { getVerifiedHazardsForTrail } from './hazardService';

/**
 * Builds the self-contained bundle a device downloads before going offline.
 * Only 'official' or 'promoted' landmark photos are ever included — a photo a
 * hiker contributed in the field does not ship to other users until the
 * corroboration/manual-review pipeline in contributionService has promoted
 * it into landmarkPhotoService's store (see docs/roadmap.md item 4).
 * Likewise, only 'verified' hazard reports ship — see hazardService.
 */
export function buildTripPackage(trailId: string): TripPackage | null {
  const trail = getTrailById(trailId);
  if (!trail) return null;

  const photos = getShippablePhotosForTrail(trailId);
  const hazards = getVerifiedHazardsForTrail(trailId);

  return {
    trailId,
    trailVersion: trail.version,
    generatedAt: new Date().toISOString(),
    trail,
    mapTiles: {
      bufferMeters: 500,
      tileFormat: 'mbtiles',
      uri: `offline-tiles/${trailId}-v${trail.version}.mbtiles`,
    },
    landmarkPhotos: photos,
    hazards,
  };
}
