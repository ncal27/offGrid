import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Minimal gate for the human-review endpoints (promote/reject). There's no
 * user/auth system yet, so these endpoints were previously open to anyone, and
 * anyone could push any photo into the official trail data that ships to
 * every hiker (BUG-009).
 *
 * Until real accounts and roles exist, reviewers send a shared secret:
 *   Authorization: Bearer <OFFGRID_REVIEWER_TOKEN>
 *
 * - If OFFGRID_REVIEWER_TOKEN is not set, the endpoints are DISABLED (503).
 *   They fail closed, not open, so forgetting to configure a token can't
 *   expose them.
 * - Tokens shorter than 32 characters are treated as not configured, so a
 *   placeholder like "changeme" can't accidentally become the real gate.
 * - Comparison hashes both sides and uses timingSafeEqual, so response
 *   timing doesn't leak how much of a guessed token was right.
 *
 * Replace with real per-user auth (e.g. OAuth + a 'reviewer' role) before
 * this ever faces the public internet. A shared secret can't tell you WHICH
 * reviewer approved something.
 */
export const MIN_REVIEWER_TOKEN_LENGTH = 32;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export function requireReviewer(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.OFFGRID_REVIEWER_TOKEN;
  if (!configured || configured.length < MIN_REVIEWER_TOKEN_LENGTH) {
    res.status(503).json({ error: 'review_endpoints_disabled' });
    return;
  }

  const header = req.get('authorization') ?? '';
  const match = /^Bearer ([^\s]{1,512})$/.exec(header);
  if (!match || !timingSafeEqual(sha256(match[1]), sha256(configured))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
