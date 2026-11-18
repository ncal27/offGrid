import { LandmarkPhoto } from '@offgrid/shared';
import { photosByTrailId as officialPhotosByTrailId } from '../data/fixtures';

/**
 * Canonical store of landmark photos per trail — seeded from the official
 * fixture data, then grown over time as contributionService promotes
 * corroborated hiker contributions into it. packageService reads from here
 * (not from the fixtures directly) so promoted photos actually ship.
 */
function seedPhotos(): Map<string, LandmarkPhoto[]> {
  const map = new Map<string, LandmarkPhoto[]>();
  for (const [trailId, photos] of Object.entries(officialPhotosByTrailId)) {
    map.set(trailId, [...photos]);
  }
  return map;
}

let photosByTrailId = seedPhotos();

export function getAllPhotosForTrail(trailId: string): LandmarkPhoto[] {
  return photosByTrailId.get(trailId) ?? [];
}

/** Only 'official' and 'promoted' photos are ever safe to ship in a TripPackage. */
export function getShippablePhotosForTrail(trailId: string): LandmarkPhoto[] {
  return getAllPhotosForTrail(trailId).filter((p) => p.status === 'official' || p.status === 'promoted');
}

export function addPromotedPhoto(photo: LandmarkPhoto): void {
  const existing = photosByTrailId.get(photo.trailId) ?? [];
  photosByTrailId.set(photo.trailId, [...existing, photo]);
}

/** Test-only helper to reset in-memory state between test cases. */
export function _resetForTests(): void {
  photosByTrailId = seedPhotos();
}
