import sharp from 'sharp';

/**
 * Real, decodable test images. The upload pipeline now fully decodes and
 * re-encodes every photo (src/validation/imageValidation.ts), so the old
 * placeholder ("JPEG magic bytes + 16 bytes of 0x01") is correctly rejected
 * as corrupt. Same class of breakage as BUG-003.
 */
export async function makeImage(
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
  width = 64,
  height = 48,
  opts: { exifGps?: boolean } = {},
): Promise<Buffer> {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 60 } },
  });
  if (opts.exifGps) {
    img = img.withExif({
      IFD0: { Copyright: 'SECRET-EXIF-MARKER', Make: 'TestCam' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '119/1 30/1 0/1' },
    });
  }
  return img.toFormat(format).toBuffer();
}

export async function makeImageBase64(...args: Parameters<typeof makeImage>): Promise<string> {
  return (await makeImage(...args)).toString('base64');
}
