import sharp, { Metadata } from 'sharp';
import { isStrictBase64 } from '@offgrid/shared';

/**
 * Validates AND sanitizes a base64-encoded photo upload. Nothing the client
 * sent is ever stored: the stored image is a fresh JPEG that sharp re-encodes
 * from the decoded pixels.
 *
 * Layers, cheapest first, so obviously-bad input is rejected before any
 * expensive work happens:
 *  1. Type/size checks on the raw string (before decoding anything).
 *  2. Strict base64 check (linear-time loop, see isStrictBase64 / BUG-004).
 *  3. Decoded byte-size cap.
 *  4. Magic-byte sniffing: the bytes must actually start like a JPEG, PNG or
 *     WebP file (WebP requires both "RIFF" and "WEBP", not just "RIFF",
 *     which also matches WAV/AVI files; see BUG-008).
 *  5. Header inspection with sharp: the format sharp detects must match the
 *     sniffed one, dimensions must be sane, and the total pixel count is capped
 *     *before* full decode. This is the decompression-bomb guard: a tiny
 *     compressed file can claim 100,000 x 100,000 pixels and would otherwise
 *     allocate tens of GB when decoded.
 *  6. Full decode + re-encode. This:
 *       - proves the file is a decodable image, not just something with the
 *         right first few bytes (polyglot files, truncated/corrupt data);
 *       - strips ALL metadata (EXIF incl. GPS coordinates, camera serials,
 *         XMP, ICC, comments). sharp drops metadata unless told to keep it;
 *       - applies the EXIF orientation first, so stripping EXIF doesn't leave
 *         the photo sideways;
 *       - throws away any bytes hidden after the image data or in unusual
 *         segments, because only pixels survive a re-encode;
 *       - downsizes very large photos to a bounded size for storage.
 *
 * Still NOT handled here (see docs/roadmap.md item 8): face blurring, nudity
 * and content moderation, duplicate detection.
 */

export const MAX_BASE64_LENGTH = 12 * 1024 * 1024; // checked before decoding
export const MAX_DECODED_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB of actual image bytes
/** Anything beyond this is refused before full decode (decompression-bomb guard). ~40 megapixels. */
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_INPUT_DIMENSION = 12_000;
export const MIN_INPUT_DIMENSION = 16;
/** Longest edge of the stored, re-encoded image. */
export const OUTPUT_MAX_DIMENSION = 2048;
const OUTPUT_JPEG_QUALITY = 85;

type SniffedFormat = 'jpeg' | 'png' | 'webp';

function sniffFormat(bytes: Buffer): SniffedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export interface SanitizedImage {
  /** Re-encoded JPEG, metadata stripped. This is the ONLY image data that should ever be stored. */
  jpeg: Buffer;
  width: number;
  height: number;
  originalFormat: SniffedFormat;
  originalByteLength: number;
}

export type ImageSanitizationResult =
  | { valid: true; image: SanitizedImage }
  | { valid: false; error: string };

const fail = (error: string): ImageSanitizationResult => ({ valid: false, error });

export async function sanitizeBase64Image(imageBase64: unknown): Promise<ImageSanitizationResult> {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return fail('imageBase64 must be a non-empty string');
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return fail('imageBase64 exceeds the maximum allowed size');
  }
  if (!isStrictBase64(imageBase64)) {
    return fail('imageBase64 is not validly encoded base64');
  }

  const decoded = Buffer.from(imageBase64, 'base64');
  if (decoded.length === 0) return fail('decoded image is empty');
  if (decoded.length > MAX_DECODED_IMAGE_BYTES) {
    return fail('decoded image exceeds the maximum allowed size (8MB)');
  }

  const sniffed = sniffFormat(decoded);
  if (!sniffed) return fail('file does not match a recognized image format (jpeg/png/webp)');

  // `limitInputPixels` makes sharp refuse oversized images from the header,
  // before allocating a pixel buffer. `failOn: 'warning'` treats corrupt or
  // truncated data as an error instead of decoding whatever it can.
  const sharpOptions = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' as const };

  let meta: Metadata;
  try {
    meta = await sharp(decoded, sharpOptions).metadata();
  } catch {
    return fail('image could not be read (corrupt or unsupported file)');
  }

  if (meta.format !== sniffed) {
    return fail('image contents do not match its file signature');
  }
  const { width, height } = meta;
  if (!width || !height) return fail('image has no readable dimensions');
  if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION || width * height > MAX_INPUT_PIXELS) {
    return fail(`image dimensions are too large (max ${MAX_INPUT_PIXELS / 1_000_000} megapixels)`);
  }
  if (width < MIN_INPUT_DIMENSION || height < MIN_INPUT_DIMENSION) {
    return fail(`image is too small (min ${MIN_INPUT_DIMENSION}x${MIN_INPUT_DIMENSION})`);
  }
  if ((meta.pages ?? 1) > 1) {
    return fail('animated or multi-page images are not accepted');
  }

  try {
    const { data, info } = await sharp(decoded, sharpOptions)
      .autoOrient()
      .resize({
        width: OUTPUT_MAX_DIMENSION,
        height: OUTPUT_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' }) // PNG/WebP transparency -> white, since JPEG has no alpha
      .jpeg({ quality: OUTPUT_JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      valid: true,
      image: {
        jpeg: data,
        width: info.width,
        height: info.height,
        originalFormat: sniffed,
        originalByteLength: decoded.length,
      },
    };
  } catch {
    return fail('image could not be decoded (corrupt or unsupported file)');
  }
}
