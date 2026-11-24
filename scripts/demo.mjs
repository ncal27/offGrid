#!/usr/bin/env node
/**
 * End-to-end demo against the REAL backend: starts the API, walks through a
 * hiker's day (plan, download, report a hazard, others confirm it, upload a
 * photo, try some bad input), prints what happens, then stops the server.
 *
 *   npm run demo
 *
 * Uses a random free port, and a throwaway reviewer token that exists only
 * for this run.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'backend', 'package.json'));
const sharp = require('sharp');

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [require.resolve('ts-node/dist/bin.js'), 'src/index.ts'], {
  cwd: join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(PORT), OFFGRID_REVIEWER_TOKEN: randomBytes(24).toString('hex') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const step = (n, text) => console.log(`\n${n}. ${text}`);
const show = (text) => console.log(`   ${text}`);

try {
  // Wait for the server (ts-node compiles on start, so give it a moment).
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 60 || server.exitCode !== null) throw new Error(`Server did not start.\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`OffGrid API running at ${BASE}`);

  step(1, 'Plan: search for a trail');
  const search = await call('GET', '/trails/search?q=creek');
  const trail = search.body[0];
  show(`Found "${trail.name}" (${(trail.distanceMeters / 1609).toFixed(1)} mi, +${trail.elevationGainMeters} m)`);

  step(2, 'Download: get the offline trip package');
  const pkg = (await call('POST', `/trails/${trail.id}/package`)).body;
  show(`${pkg.trail.waypoints.length} waypoints, ${pkg.landmarkPhotos.length} reference photos, ${pkg.hazards.length} hazards, version ${pkg.trailVersion}`);
  const wp = pkg.trail.waypoints[0];

  step(3, `Hazard: hiker-1 reports a downed tree at "${wp.name}"`);
  const near = { lat: wp.location.lat + 0.00005, lng: wp.location.lng };
  const report = await call('POST', '/hazards/reports', {
    trailId: trail.id,
    hazardType: 'downed_tree',
    severity: 'moderate',
    description: 'Big tree across the trail, you can climb over it.',
    reportedAt: new Date().toISOString(),
    location: near,
    gpsWeakOrMissing: false,
    reporterId: 'hiker-1',
  });
  show(`${report.status}: ${report.body.message}`);
  const incidentId = report.body.incidentId;

  step(4, 'Other hikers pass by and answer "Still there?"');
  for (let i = 2; i <= 5; i++) {
    const v = await call('POST', '/hazards/votes', {
      id: `demo-vote-${i}`,
      incidentId,
      trailId: trail.id,
      vote: 'still_there',
      observedAt: new Date().toISOString(),
      location: near,
      gpsWeakOrMissing: false,
      voterId: `hiker-${i}`,
    });
    const h = (await call('POST', `/trails/${trail.id}/package`)).body.hazards[0];
    show(`hiker-${i} says still there -> ${h.confirmations} hikers, confidence ${h.confidence}, tier: ${h.confidenceLevel} (${v.status})`);
  }

  step(5, 'hiker-6 walks by and says "Not there"');
  await call('POST', '/hazards/votes', {
    id: 'demo-vote-6',
    incidentId,
    trailId: trail.id,
    vote: 'not_there',
    observedAt: new Date().toISOString(),
    location: near,
    gpsWeakOrMissing: false,
    voterId: 'hiker-6',
  });
  const h = (await call('POST', `/trails/${trail.id}/package`)).body.hazards[0];
  show(`now ${h.confidence} confidence, tier: ${h.confidenceLevel}; expires ${h.expiresAt.slice(0, 16)} unless re-confirmed`);

  step(6, 'Photo: hiker-1 uploads a landmark photo (EXIF with GPS included)');
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 60, g: 110, b: 70 } } })
    .withExif({ IFD0: { Copyright: 'SECRET-EXIF' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '42/1 17/1 0/1' } })
    .jpeg()
    .toBuffer();
  const photo = await call('POST', '/contributions/photos', {
    trailId: trail.id,
    waypointHintId: wp.id,
    capturedAt: new Date().toISOString(),
    location: near,
    gpsWeakOrMissing: false,
    imageBase64: jpeg.toString('base64'),
    contributorId: 'hiker-1',
  });
  show(`${photo.status}: ${photo.body.message} (stored copy is re-encoded, EXIF/GPS stripped)`);

  step(7, 'Bad input is refused cleanly');
  const traversal = await call('POST', '/contributions/photos', { ...{ trailId: '../../etc/passwd' } });
  show(`path-traversal trailId -> ${traversal.status} ${traversal.body.error}`);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)]);
  const fake = await call('POST', '/contributions/photos', {
    trailId: trail.id,
    capturedAt: new Date().toISOString(),
    imageBase64: wav.toString('base64'),
    contributorId: 'hiker-1',
  });
  show(`audio file posing as an image -> ${fake.status}: ${fake.body.details?.[0]}`);
  const promote = await call('POST', `/contributions/x/promote`, {});
  show(`promote a photo without the reviewer token -> ${promote.status} ${promote.body.error}`);

  console.log('\nDemo complete. Server stopped.');
} catch (err) {
  console.error('\nDemo failed:', err.message);
  process.exitCode = 1;
} finally {
  stop();
}
