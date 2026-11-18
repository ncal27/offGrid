/**
 * The on-device visual place recognition model integration point. This is
 * deliberately a narrow interface — "turn a photo into a feature vector" —
 * rather than a general-purpose vision/AI call, per the decision to use a
 * model specialized for place/landmark matching instead of a do-everything
 * multimodal model (see docs/architecture.md for the HOGNet / MSGC-NetVLAD /
 * EigenPlaces research this is meant to be backed by). A real build exports a
 * trained VPR model to TFLite/Core ML/ONNX and runs it here; tests use a fake
 * that returns scripted embeddings (see testUtils/mockAdapters.ts).
 */
export interface EmbeddingAdapter {
  embed(photoUri: string): Promise<number[]>;
}
