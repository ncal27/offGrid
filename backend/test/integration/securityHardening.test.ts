import { deflateSync } from 'zlib';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/app';
import { SHADOW_CREEK_TRAIL_ID } from '../../src/data/fixtures';
import { makeImage, makeImageBase64 } from '../helpers/images';
import { _resetForTests as resetContributions, listPendingForTrail } from '../../src/services/contributionService';
import { _resetForTests as resetHazards, listIncidentsForTrail } from '../../src/services/hazardService';
import { _resetForTests as resetPhotos } from '../../src/services/landmarkPhotoService';
import { OUTPUT_MAX_DIMENSION } from '../../src/validation/imageValidation';

/**
 * Use case: someone (malicious, or just a buggy client) tries to break the
 * system or slip bad data into what ships to other hikers. Each `describe`
 * maps to a logged bug in docs/BUGS.md or an image-sanitization guarantee.
 */

/** Hand-built PNG whose header *claims* huge dimensions but whose file is tiny: a decompression bomb. */
function pngBomb(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const REVIEWER_TOKEN = 'test-reviewer-token-0123456789abcdef0123456789';

describe('Use case: the system resists malicious or accidental abuse', () => {
  const app = createApp({ writeRateLimit: false });
  let img: string;

  beforeAll(async () => {
    img = await makeImageBase64();
  });

  beforeEach(() => {
    resetContributions();
    resetHazards();
    resetPhotos();
    delete process.env.OFFGRID_REVIEWER_TOKEN;
  });

  const contribution = (o: Record<string, unknown> = {}) => ({
    trailId: SHADOW_CREEK_TRAIL_ID,
    capturedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    imageBase64: img,
    contributorId: 'hiker-1',
    ...o,
  });
  const hazard = (o: Record<string, unknown> = {}) => ({
    trailId: SHADOW_CREEK_TRAIL_ID,
    hazardType: 'downed_tree',
    severity: 'moderate',
    reportedAt: new Date().toISOString(),
    gpsWeakOrMissing: false,
    reporterId: 'hiker-1',
    ...o,
  });
  const postPhoto = (body: unknown) => request(app).post('/contributions/photos').send(body as object);
  const postHazard = (body: unknown) => request(app).post('/hazards/reports').send(body as object);
  const pkg = () => request(app).post(`/trails/${SHADOW_CREEK_TRAIL_ID}/package`);

  describe('image sanitization', () => {
    it('strips EXIF metadata (incl. GPS) and stores a re-encoded JPEG, not the original bytes', async () => {
      const withExif = await makeImage('jpeg', 64, 48, { exifGps: true });
      expect(withExif.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(true); // sanity: marker is in the input

      const res = await postPhoto(contribution({ imageBase64: withExif.toString('base64') }));
      expect(res.status).toBe(202);

      const stored = Buffer.from(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)[0].imageBase64, 'base64');
      expect(stored.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(false);
      const meta = await sharp(stored).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([64, 48]);
    });

    it('drops data hidden after the image (polyglot / appended payload)', async () => {
      const jpeg = await makeImage();
      const polyglot = Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>HIDDEN-PAYLOAD')]);
      const res = await postPhoto(contribution({ imageBase64: polyglot.toString('base64') }));
      // Either rejected as corrupt or accepted with the payload stripped; never stored as-is.
      if (res.status === 202) {
        const stored = Buffer.from(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)[0].imageBase64, 'base64');
        expect(stored.includes(Buffer.from('HIDDEN-PAYLOAD'))).toBe(false);
      } else {
        expect(res.status).toBe(400);
      }
    });

    it('accepts PNG and WebP but stores them as JPEG', async () => {
      for (const format of ['png', 'webp'] as const) {
        resetContributions();
        const res = await postPhoto(contribution({ imageBase64: await makeImageBase64(format) }));
        expect(res.status).toBe(202);
        const stored = Buffer.from(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)[0].imageBase64, 'base64');
        expect((await sharp(stored).metadata()).format).toBe('jpeg');
      }
    });

    it('downsizes very large photos for storage', async () => {
      const big = await makeImageBase64('jpeg', 3000, 1500);
      expect((await postPhoto(contribution({ imageBase64: big }))).status).toBe(202);
      const stored = Buffer.from(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)[0].imageBase64, 'base64');
      const meta = await sharp(stored).metadata();
      expect(meta.width).toBe(OUTPUT_MAX_DIMENSION);
      expect(meta.height).toBe(OUTPUT_MAX_DIMENSION / 2);
    });

    it('rejects a decompression bomb (tiny file claiming 50,000 x 50,000 pixels) before decoding it', async () => {
      const bomb = pngBomb(50_000, 50_000);
      expect(bomb.length).toBeLessThan(5_000);
      const res = await postPhoto(contribution({ imageBase64: bomb.toString('base64') }));
      expect(res.status).toBe(400);
      expect(res.body.details[0]).toMatch(/imageBase64/);
    });

    it('rejects a file with valid JPEG magic bytes but garbage after them', async () => {
      const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 1)]);
      const res = await postPhoto(contribution({ imageBase64: fake.toString('base64') }));
      expect(res.status).toBe(400);
    });

    it('rejects a truncated (half-uploaded) image', async () => {
      const jpeg = await makeImage('jpeg', 256, 256);
      const res = await postPhoto(contribution({ imageBase64: jpeg.subarray(0, jpeg.length / 2).toString('base64') }));
      expect(res.status).toBe(400);
    });

    it('rejects a WAV/AVI-style RIFF file posing as WebP (BUG-008)', async () => {
      const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)]);
      const res = await postPhoto(contribution({ imageBase64: wav.toString('base64') }));
      expect(res.status).toBe(400);
    });

    it('rejects unsupported formats even if real images (e.g. GIF, SVG)', async () => {
      const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).gif().toBuffer();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      for (const file of [gif, svg]) {
        expect((await postPhoto(contribution({ imageBase64: file.toString('base64') }))).status).toBe(400);
      }
    });

    it('rejects tiny 1x1 "tracking pixel" style images', async () => {
      const res = await postPhoto(contribution({ imageBase64: await makeImageBase64('png', 1, 1) }));
      expect(res.status).toBe(400);
    });

    it('does not crash on a large valid-base64 payload (BUG-004 regression: regex stack overflow -> 500)', async () => {
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8.2 * 1024 * 1024, 7)]).toString('base64');
      const res = await postPhoto(contribution({ imageBase64: big }));
      expect(res.status).toBe(400);
    }, 20000);
  });

  describe('references must point at things that exist (BUG-005, BUG-006)', () => {
    it('rejects contributions and hazards for a trail that does not exist', async () => {
      expect((await postPhoto(contribution({ trailId: 'no-such-trail' }))).status).toBe(404);
      expect((await postHazard(hazard({ trailId: 'no-such-trail' }))).status).toBe(404);
    });

    it('rejects a waypointHintId that is not on the trail, so it cannot be auto-promoted', async () => {
      const res = await postPhoto(contribution({ waypointHintId: 'fake-wp' }));
      expect(res.status).toBe(400);
      expect((await postHazard(hazard({ waypointHintId: 'fake-wp' }))).status).toBe(400);
    });

    it('ignores a waypoint hint contradicted by the GPS location', async () => {
      const farAway = { lat: 0, lng: 0 };
      await postPhoto(contribution({ waypointHintId: 'scl-wp1', location: farAway, contributorId: 'a' }));
      const second = await postPhoto(contribution({ waypointHintId: 'scl-wp1', location: farAway, contributorId: 'b' }));
      expect(second.body.status).toBe('pending_review');
    });

    it('does not let two location-less hazard reports "corroborate" each other (BUG-014)', async () => {
      // Ironhide: BUG-014. Single reports are now shared (at very low
      // confidence), so the guard is that position-less reports never merge
      // into one hazard that looks confirmed by 2 hikers.
      const first = await postHazard(hazard({ reporterId: 'a' }));
      const second = await postHazard(hazard({ reporterId: 'b' }));
      expect(second.body.incidentId).not.toBe(first.body.incidentId);
      const hazards = (await pkg()).body.hazards;
      expect(hazards.every((h: { confirmations: number }) => h.confirmations === 1)).toBe(true);
    });
  });

  describe('submission IDs (BUG-007)', () => {
    it("rejects reusing someone else's submission id instead of overwriting their contribution", async () => {
      await postPhoto(contribution({ id: 'shared-id', contributorId: 'victim' }));
      const res = await postPhoto(contribution({ id: 'shared-id', contributorId: 'attacker' }));
      expect(res.status).toBe(409);
      expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)[0].contributorId).toBe('victim');
    });

    it('treats a retry of the same submission as idempotent (no duplicate photo or hazard)', async () => {
      const first = await postPhoto(contribution({ id: 'retry-1' }));
      const retry = await postPhoto(contribution({ id: 'retry-1' }));
      expect(first.status).toBe(202);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);

      // Ironhide: BUG-007. Under the consensus rule a single report is never
      // shared, so check the underlying state instead: a resent report must
      // not create a second hazard. (It has no position, so without the
      // idempotency check each copy would become its own incident.)
      const report = hazard({ id: 'retry-h', severity: 'impassable', hazardType: 'bridge_out' });
      const h1 = await postHazard(report);
      const h2 = await postHazard(report);
      expect(h1.status).toBe(202);
      expect(h2.status).toBe(200);
      expect(h2.body).toEqual(h1.body);
      expect(listIncidentsForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);
    });
  });

  describe('review endpoints (BUG-009)', () => {
    it('are disabled when no reviewer token is configured', async () => {
      const sub = await postPhoto(contribution());
      const res = await request(app).post(`/contributions/${sub.body.id}/promote`).send({});
      expect(res.status).toBe(503);
      expect(listPendingForTrail(SHADOW_CREEK_TRAIL_ID)).toHaveLength(1);
    });

    it('refuse a short placeholder token as configuration', async () => {
      process.env.OFFGRID_REVIEWER_TOKEN = 'changeme';
      const res = await request(app).post('/contributions/x/reject').set('Authorization', 'Bearer changeme');
      expect(res.status).toBe(503);
    });

    it('reject a missing or wrong token', async () => {
      process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
      const sub = await postPhoto(contribution());
      expect((await request(app).post(`/contributions/${sub.body.id}/promote`).send({})).status).toBe(401);
      expect(
        (await request(app).post(`/contributions/${sub.body.id}/promote`).set('Authorization', 'Bearer nope').send({}))
          .status,
      ).toBe(401);
      expect((await pkg()).body.landmarkPhotos.some((p: { source: string }) => p.source === 'contributed')).toBe(false);
    });

    it('do not let a reviewer attach a photo to a waypoint on a different trail', async () => {
      process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
      const sub = await postPhoto(contribution());
      const res = await request(app)
        .post(`/contributions/${sub.body.id}/promote`)
        .set('Authorization', `Bearer ${REVIEWER_TOKEN}`)
        .send({ waypointId: 'some-other-trails-wp' });
      expect(res.status).toBe(400);
    });

    it('validate the id on reject too', async () => {
      process.env.OFFGRID_REVIEWER_TOKEN = REVIEWER_TOKEN;
      const res = await request(app)
        .post('/contributions/bad%20id%3B/reject')
        .set('Authorization', `Bearer ${REVIEWER_TOKEN}`);
      expect(res.status).toBe(400);
    });
  });

  describe('free-text fields', () => {
    it('rejects bidi-override "Trojan Source" text and zero-width characters (BUG-015)', async () => {
      expect((await postHazard(hazard({ description: 'safe ‮elbassapmi' }))).status).toBe(400);
      expect((await postHazard(hazard({ description: 'brid​ge out' }))).status).toBe(400);
    });

    it('rejects whitespace-only descriptions', async () => {
      expect((await postHazard(hazard({ description: '     ' }))).status).toBe(400);
    });

    it('accepts ordinary multi-line, accented, and emoji text', async () => {
      const res = await postHazard(hazard({ description: 'Árbol caído 🌲\nPassable on the left.' }));
      expect(res.status).toBe(202);
    });

    it('ignores prototype-pollution style keys instead of applying them', async () => {
      const res = await request(app)
        .post('/hazards/reports')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ ...hazard(), __proto__: { isAdmin: true }, constructor: { prototype: { x: 1 } } }));
      expect(res.status).toBe(202);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    });
  });

  describe('request-level limits (BUG-010) and API hygiene', () => {
    it('refuses a large body on non-upload routes before parsing it', async () => {
      const res = await postHazard(hazard({ junk: 'x'.repeat(500_000) }));
      expect(res.status).toBe(413);
    });

    it('rejects malformed trail ids and over-long search queries', async () => {
      expect((await request(app).get('/trails/bad%20id%3B')).status).toBe(400);
      expect((await request(app).get(`/trails/search?q=${'a'.repeat(500)}`)).status).toBe(400);
      expect((await request(app).get('/trails/search?q=a&q=b')).status).toBe(200);
    });

    it('sends hardening headers and no framework fingerprint', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns JSON 404s for unknown routes', async () => {
      const res = await request(app).get('/nope');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });
  });
});

describe('Use case: one client floods the write endpoints', () => {
  it('rate-limits writes per IP', async () => {
    resetHazards();
    const app = createApp({ writeRateLimit: { windowMs: 60_000, max: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/hazards/reports')
        .send({
          trailId: SHADOW_CREEK_TRAIL_ID,
          hazardType: 'other',
          severity: 'minor',
          reportedAt: new Date().toISOString(),
          reporterId: `rotating-id-${i}`, // inventing new IDs doesn't help
        });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    // Reads are not rate limited.
    expect((await request(app).get('/trails/search')).status).toBe(200);
  });
});

describe('Use case: internal failures are reported honestly (Ironhide: BUG-016)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trailService = require('../../src/services/trailService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const requestValidation = require('../../src/validation/requestValidation');
  const app = createApp({ writeRateLimit: false });
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports a SyntaxError thrown by our own code as a 500, not "your JSON is invalid"', async () => {
    jest.spyOn(trailService, 'searchTrails').mockImplementation(() => {
      throw new SyntaxError('bug in our code');
    });
    const res = await request(app).get('/trails/search?q=x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_server_error' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns a 500 (instead of hanging) when the async photo route fails unexpectedly', async () => {
    jest.spyOn(requestValidation, 'validateContributedPhotoUploadBody').mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/contributions/photos').send({}).timeout(5000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_server_error' });
  });
});
