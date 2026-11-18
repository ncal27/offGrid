import { LandmarkPhoto, PhotoMatchCandidate, PhotoMatchResult } from '@offgrid/shared';
import { EmbeddingAdapter } from './adapters';

export interface LandmarkMatcherOptions {
  /** Cosine similarity required to count as a confirmed match. Default 0.75. */
  matchThreshold?: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    // A NaN/Infinity anywhere (bad model output, corrupted package) would make
    // every similarity NaN, and NaN breaks sorting and threshold checks
    // (BUG-013). Treat it as "no match".
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(sim) ? sim : 0;
}

/**
 * Confirms position/trail-correctness by comparing a photo taken in the
 * field against the small set of reference landmark photos that shipped in
 * the trail's downloaded package — useful when GPS is weak/blocked (dense
 * canopy) or as a sanity check that you're still on the intended trail.
 *
 * This only ever searches the handful of waypoint photos for one trail, not
 * a city- or planet-scale database, which is why a lightweight embedding
 * model (see EmbeddingAdapter) is sufficient here even though general visual
 * place recognition is a much harder open problem.
 */
export class LandmarkMatcher {
  private threshold: number;

  constructor(private embeddingAdapter: EmbeddingAdapter, options: LandmarkMatcherOptions = {}) {
    this.threshold = options.matchThreshold ?? 0.75;
  }

  async matchPhoto(photoUri: string, referencePhotos: LandmarkPhoto[]): Promise<PhotoMatchResult> {
    const withEmbeddings = referencePhotos.filter((p) => p.embedding && p.embedding.length > 0);
    if (withEmbeddings.length === 0) {
      return { matched: false, confidence: 0, candidates: [] };
    }

    const queryEmbedding = await this.embeddingAdapter.embed(photoUri);

    const candidates: PhotoMatchCandidate[] = withEmbeddings
      .map((p) => ({
        waypointId: p.waypointId,
        photoId: p.id,
        similarity: cosineSimilarity(queryEmbedding, p.embedding as number[]),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const best = candidates[0];
    const matched = !!best && best.similarity >= this.threshold;

    return {
      matched,
      confidence: best?.similarity ?? 0,
      bestCandidate: matched ? best : undefined,
      candidates,
    };
  }
}
