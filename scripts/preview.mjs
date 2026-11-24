#!/usr/bin/env node
/**
 * Runs the API and the web build of the app behind ONE address, so the app
 * can be tried in any browser (including a remote preview) without CORS or
 * "localhost means a different machine" problems.
 *
 *   cd app && npm run build:web     # once, after app changes
 *   npm run preview                 # http://localhost:8080, stops after 30 min
 *   npm run preview -- --port 9000 --minutes 60
 *
 * API paths (/trails, /hazards, /contributions, /health) go to the backend;
 * everything else is served from app/dist. Data is in memory and resets when
 * this stops.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'app', 'dist');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const PORT = arg('port', 8080);
const MINUTES = arg('minutes', 30);
const API_PORT = PORT + 1;
const API_PREFIXES = ['/trails', '/hazards', '/contributions', '/photos', '/health'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('No web build found. Run first:  cd app && npm run build:web');
  process.exit(1);
}

const require = createRequire(join(ROOT, 'backend', 'package.json'));
const api = spawn(process.execPath, [require.resolve('ts-node/dist/bin.js'), 'src/index.ts'], {
  cwd: join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(API_PORT) },
  stdio: 'inherit',
});

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    const upstream = request(
      { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"api_starting_try_again"}');
    });
    req.pipe(upstream);
    return;
  }
  // Static files, confined to app/dist; unknown paths fall back to index.html.
  let file = normalize(join(DIST, decodeURIComponent(path)));
  if (!file.startsWith(DIST + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const shutdown = () => {
  server.close();
  api.kill('SIGTERM');
  process.exit(0);
};
server.listen(PORT, () => {
  console.log(`OffGrid preview: http://localhost:${PORT}  (stops automatically in ${MINUTES} min; Ctrl+C to stop now)`);
});
setTimeout(() => {
  console.log('Preview time limit reached, stopping.');
  shutdown();
}, MINUTES * 60_000).unref();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
api.on('exit', (code) => {
  if (code) console.error(`API exited (${code}).`);
  shutdown();
});
