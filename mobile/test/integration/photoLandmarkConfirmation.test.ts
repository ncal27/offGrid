import { LandmarkMatcher } from '../../src/core';
import { FakeEmbeddingAdapter } from '../../src/testUtils/mockAdapters';
import { officialLandmarkPhotos } from '../../src/testUtils/fixtures';

/**
 * Use case: a hiker's GPS is weak or they just want confirmation they're in
 * the right spot, so they take a photo and the app checks it against the
 * trail's downloaded reference landmark photos.
 */
describe('Use case: confirm position in the field with a photo', () => {
  it('confirms a strong match against the correct waypoint', async () => {
    const queryPhotoUri = 'camera-roll/in-field-shot-1.jpg';
    // Identical to waypoint 1's reference embedding, simulating the on-device
    // VPR model recognizing the same landmark from a new angle/lighting.
    const embeddingAdapter = new FakeEmbeddingAdapter({
      [queryPhotoUri]: officialLandmarkPhotos[0].embedding!,
    });
    const matcher = new LandmarkMatcher(embeddingAdapter);

    const result = await matcher.matchPhoto(queryPhotoUri, officialLandmarkPhotos);

    expect(result.matched).toBe(true);
    expect(result.bestCandidate?.waypointId).toBe('scl-wp1');
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('reports low confidence instead of a false match when the photo does not resemble any known waypoint', async () => {
    const queryPhotoUri = 'camera-roll/unrelated-shot.jpg';
    // Deliberately orthogonal-ish vector unrelated to either reference embedding.
    const embeddingAdapter = new FakeEmbeddingAdapter({
      [queryPhotoUri]: Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 1 : -1)),
    });
    const matcher = new LandmarkMatcher(embeddingAdapter);

    const result = await matcher.matchPhoto(queryPhotoUri, officialLandmarkPhotos);

    expect(result.matched).toBe(false);
    expect(result.bestCandidate).toBeUndefined();
    // Still surfaces candidates so the UI can show "closest guess, low confidence" rather than nothing.
    expect(result.candidates.length).toBe(2);
  });

  it('declines to match when the trail package shipped with no embedded reference photos at all', async () => {
    const embeddingAdapter = new FakeEmbeddingAdapter({});
    const matcher = new LandmarkMatcher(embeddingAdapter);

    const result = await matcher.matchPhoto('camera-roll/shot.jpg', []);

    expect(result.matched).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });
});
