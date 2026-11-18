import express from 'express';
import rateLimit from 'express-rate-limit';
import { trailsRouter } from './routes/trails';
import { contributionsRouter } from './routes/contributions';
import { hazardsRouter } from './routes/hazards';

export interface AppOptions {
  /**
   * Per-IP limit on write requests (photo uploads, hazard reports, review
   * actions). Contributor/reporter IDs are self-asserted with no auth, so
   * per-contributor caps are trivially bypassed by inventing IDs. Per-IP
   * limiting is the control that actually holds. Pass `false` to disable
   * (tests only).
   */
  writeRateLimit?: { windowMs: number; max: number } | false;
  /**
   * Set when running behind a reverse proxy / load balancer (e.g. 1 for a
   * single proxy hop) so rate limiting sees the real client IP instead of
   * the proxy's. Leave unset when clients connect directly; trusting
   * X-Forwarded-For without a proxy lets clients spoof their IP.
   */
  trustProxy?: number | boolean;
}

const DEFAULT_WRITE_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 100 };

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);

  // Basic hardening headers for a JSON-only API.
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  const writeLimit = options.writeRateLimit ?? DEFAULT_WRITE_RATE_LIMIT;
  if (writeLimit) {
    const limiter = rateLimit({
      windowMs: writeLimit.windowMs,
      limit: writeLimit.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    });
    app.use(['/contributions', '/hazards'], (req, res, next) =>
      req.method === 'GET' ? next() : limiter(req, res, next),
    );
  }

  // Body size limits are per route (BUG-010). Only the photo-upload route
  // needs a large body: base64 inflates size by ~33%, so an image at
  // imageValidation's 8MB decoded cap needs ~10.7MB of text, hence 15mb
  // (BUG-002). Every other route gets 100kb, so a 15MB junk body sent to,
  // say, /hazards/reports is refused before it's parsed.
  // body-parser skips requests already parsed, so the larger limit must be
  // registered first. `strict: true` (the default) only accepts objects/arrays.
  app.use('/contributions/photos', express.json({ limit: '15mb', strict: true }));
  app.use(express.json({ limit: '100kb', strict: true }));

  app.use('/trails', trailsRouter);
  app.use('/contributions', contributionsRouter);
  app.use('/hazards', hazardsRouter);
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Centralized error handling, so a malformed or oversized request body gets
  // a clean structured response instead of a stack trace (an information
  // leak). Must be registered last with all 4 params, which is how Express
  // recognizes error-handling middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    // Only classify body-parser errors by their `type` (BUG-016). The old
    // `err instanceof SyntaxError` check also matched SyntaxErrors thrown by
    // our own code and reported them to the client as "your JSON is bad".
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_body_too_large' });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json_body' });
      return;
    }
    if ((typeof err?.type === 'string' && err.type.startsWith('encoding.')) || err?.type === 'charset.unsupported') {
      res.status(415).json({ error: 'unsupported_body_encoding' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
