import { LatLng } from './types';

/**
 * Reusable, runtime-checkable validators for anything that crosses a trust
 * boundary — currently used by the backend's request validation (the
 * authoritative gate) and, for defense in depth, by the mobile queues before
 * they even bother persisting something locally that the backend would just
 * reject later. Kept dependency-free (no Node-only APIs like Buffer) so it
 * works unmodified in React Native.
 *
 * These are deliberately *rejecting* validators, not silent sanitizers —
 * e.g. a string containing control characters is rejected outright rather
 * than stripped and quietly accepted. Silently "cleaning" malformed input
 * can mask bugs or attacks; an explicit 400 with a reason is easier to
 * reason about at an API boundary than "it worked, but not with what you
 * actually sent."
 */

/**
 * Safe for use as a path segment / lookup key (trail IDs, waypoint IDs,
 * contribution IDs, contributor/reporter IDs all go through this). Matters
 * because several of these values get interpolated directly into
 * storage-key-shaped strings (see packageService/contributionService/
 * hazardService's `uri` construction) — without this, a value like
 * `../../etc/passwd` or `..%2f..%2f` could attempt path traversal if those
 * URIs are ever used against a real filesystem/object-store backend instead
 * of today's in-memory stub.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isSafeOptionalId(value: unknown): boolean {
  return value === undefined || isSafeId(value);
}

export function isValidLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.lat === 'number' &&
    Number.isFinite(v.lat) &&
    v.lat >= -90 &&
    v.lat <= 90 &&
    typeof v.lng === 'number' &&
    Number.isFinite(v.lng) &&
    v.lng >= -180 &&
    v.lng <= 180
  );
}

export function isValidOptionalLatLng(value: unknown): boolean {
  return value === undefined || isValidLatLng(value);
}

const TEN_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 10;

/**
 * Must parse to a real date, and be within a sane window of "now" — guards
 * against a garbage/malicious timestamp (e.g. year 1970, year 9999, or
 * simply `NaN` from a bad client) silently poisoning the corroboration
 * time-window math in contributionService/hazardService, which assumes
 * `reportedAt`/`capturedAt` are roughly "around now."
 */
export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const now = Date.now();
  return parsed > now - TEN_YEARS_MS && parsed < now + TEN_YEARS_MS;
}

/** Allowed clock skew between a phone and the server. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Oldest field observation (hazard report / vote) we accept, e.g. synced after a long trip. */
export const MAX_OBSERVATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stricter than isValidIsoTimestamp, for anything whose age drives hazard
 * confidence decay. A timestamp in the future would make a report look
 * permanently fresh (it would never decay), so the future is limited to
 * clock skew. Very old observations are refused rather than counted.
 */
export function isRecentObservationTimestamp(value: unknown, now = Date.now()): value is string {
  if (!isValidIsoTimestamp(value)) return false;
  const t = Date.parse(value);
  return t <= now + MAX_CLOCK_SKEW_MS && t >= now - MAX_OBSERVATION_AGE_MS;
}

// Disallows C0 control characters and DEL, but allows tab/newline/carriage
// return so ordinary multi-line descriptions still work. Also disallows
// characters that are invisible or that change how surrounding text is
// displayed, all of which can be used to make a report say something
// different on screen than what a reviewer thinks it says:
//  - C1 controls (U+0080-U+009F)
//  - zero-width / invisible formatting chars (U+200B-U+200F, U+2060-U+2064, U+FEFF)
//  - Unicode line/paragraph separators (U+2028, U+2029)
//  - bidirectional overrides/isolates (U+202A-U+202E, U+2066-U+2069), the
//    "Trojan Source" trick: "safe \u202Eelbassapmi" renders as "safe impassable"
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/**
 * Free text must be within the length cap, contain at least one
 * non-whitespace character (a description of "     " is not a description),
 * and contain none of the characters above. Note this is input *validation*,
 * not output *encoding*: anything that later renders this text into HTML
 * (a future web dashboard, an email) must still escape it at render time.
 */
export function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !UNSAFE_TEXT_CHARACTER_PATTERN.test(value)
  );
}

export function isSafeOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || isSafeText(value, maxLength);
}

export function isValidEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Strict RFC 4648 base64 check (standard alphabet, correct "=" padding, length
 * a multiple of 4), written as a plain loop instead of a regex on purpose.
 *
 * The original version used a regex with a repeated group
 * (`^(?:[A-Za-z0-9+/]{4})*...$`). V8's regex engine recurses on that pattern,
 * and on a ~12MB string (a normal-sized phone photo) it throws
 * "RangeError: Maximum call stack size exceeded", which turned every large
 * upload into a 500 error (docs/BUGS.md, BUG-004). This loop is O(n), uses
 * constant stack, and works the same in Node and React Native (no Buffer).
 */
export function isStrictBase64(value: string): boolean {
  const len = value.length;
  if (len === 0 || len % 4 !== 0) return false;
  let padding = 0;
  if (value.charCodeAt(len - 1) === 61 /* = */) padding++;
  if (value.charCodeAt(len - 2) === 61) padding++;
  for (let i = 0; i < len - padding; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57) || // 0-9
      c === 43 || // +
      c === 47; // /
    if (!ok) return false;
  }
  return true;
}

/**
 * Cheap client-side sanity check (charset, padding, length). The mobile app
 * can't decode and inspect the image here without Buffer, so this is not a
 * substitute for the backend's authoritative image sanitization in
 * backend/src/validation/imageValidation.ts.
 */
export function isPlausibleBase64(value: unknown, maxEncodedLength: number): value is string {
  return typeof value === 'string' && value.length <= maxEncodedLength && isStrictBase64(value);
}
