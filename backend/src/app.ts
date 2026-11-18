import express from 'express';
import { trailsRouter } from './routes/trails';
import { contributionsRouter } from './routes/contributions';
import { hazardsRouter } from './routes/hazards';

export function createApp() {
  const app = express();
  // Raised because the contribution endpoint transports photos as base64
  // JSON. Must comfortably exceed imageValidation's own 8MB *decoded* image
  // cap, not just match it — base64 inflates size by ~33%, so an 8MB image
  // needs ~10.7MB of base64 text alone before any surrounding JSON fields.
  // A production build should switch this route to multipart/binary upload
  // instead, which wouldn't have this inflation problem.
  app.use(express.json({ limit: '15mb' }));
  app.use('/trails', trailsRouter);
  app.use('/contributions', contributionsRouter);
  app.use('/hazards', hazardsRouter);
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Centralized error handling so a malformed or oversized request body
  // returns a clean, structured response instead of an unhandled crash with
  // a stack trace — the latter is both unhelpful to a client and a
  // potential information leak if this ever reached a real deployment.
  // Must be registered last, and must declare all 4 params (err, req, res,
  // next) — that arity is how Express recognizes error-handling middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_body_too_large' });
      return;
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json_body' });
      return;
    }
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
