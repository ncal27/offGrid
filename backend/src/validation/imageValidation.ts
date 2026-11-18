/**
 * Validates a base64-encoded photo upload before it's trusted with anything
 * else. This is the Node-only half of input validation (Buffer isn't
 * available in React Native, which is why this lives in backend/ rather
 * than packages/shared alongside the generic validators).
 *
 * What this DOES catch: non-string/empty input, absurdly large payloads
 * (checked before the expensive decode step, not after), invalid base64
 * charset/padding, and content that doesn't start with a recognized
 * image file signature (jpeg/png/webp) — so a client can't, say, upload an
 * arbitrary binary blob, a text file, or an empty string and have it treated
 * as a photo.
 *
 * What this explicitly does NOT catch, and shouldn't be assumed to:
 *  - Malware/exploit payloads crafted to look like a valid image but target
 *    a parser bug in whatever actually decodes it later (this never decodes
 *    pixels, only checks a signature).
 *  - EXIF metadata, which can itself contain GPS coordinates or other
 *    personal data — stripping that is real work tracked in
 *    docs/roadmap.md item 8 (privacy/moderation), not done here.
 *  - Decompression-bomb protection for whatever real image-processing
 *    pipeline eventually resizes/thumbnails this (a small *compressed* file
 *    can still decode to a huge pixel buffer) — not a concern yet because
 *    nothing in this repo decodes pixels, but it will be the moment
 *    docs/roadmap.md item 5 (server-side embedding generation) exists.
 */

const MAX_BASE64_LENGTH = 12 * 1024 * 1024; // ~12MB of base64 text, checked before decoding
const MAX_DECODED_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB of actual image bytes

// Strict base64 charset check (RFC 4648), including correct padding — a
// permissive decoder (like Node's Buffer, which silently drops invalid
// characters instead of erroring) would otherwise let malformed input
// through disguised as something it was never valid in the first place.
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

const IMAGE_SIGNATURES: { format: string; bytes: number[] }[] = [
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP's real container check also requires 'WEBP' at byte offset 8; the
  // 'RIFF' prefix alone is a reasonable stand-in for this validator's scope.
  { format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  decodedByteLength?: number;
}

export function validateBase64Image(imageBase64: unknown): ImageValidationResult {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return { valid: false, error: 'imageBase64 must be a non-empty string' };
  }

  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return { valid: false, error: 'imageBase64 exceeds the maximum allowed size' };
  }

  if (!BASE64_PATTERN.test(imageBase64)) {
    return { valid: false, error: 'imageBase64 is not validly encoded base64' };
  }

  const decoded = Buffer.from(imageBase64, 'base64');

  if (decoded.length === 0) {
    return { valid: false, error: 'decoded image is empty' };
  }
  if (decoded.length > MAX_DECODED_IMAGE_BYTES) {
    return { valid: false, error: 'decoded image exceeds the maximum allowed size (8MB)' };
  }

  const matchesKnownFormat = IMAGE_SIGNATURES.some((sig) =>
    sig.bytes.every((byte, i) => decoded[i] === byte),
  );
  if (!matchesKnownFormat) {
    return { valid: false, error: 'file does not match a recognized image format (jpeg/png/webp)' };
  }

  return { valid: true, decodedByteLength: decoded.length };
}
