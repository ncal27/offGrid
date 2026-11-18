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

// Disallows C0 control characters and DEL, but allows tab/newline/carriage
// return so ordinary multi-line descriptions still work.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
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

// Same charset/padding check as backend/src/validation/imageValidation.ts,
// deliberately duplicated rather than shared: this package must stay
// Buffer-free to work in React Native, so it can only check that a string is
// *plausibly* base64 (right charset, sane length) — it cannot decode it and
// check magic bytes the way the Node-only backend validator does. Treat this
// as a cheap client-side sanity check, not a substitute for the backend's
// authoritative image validation.
const BASE64_CHARSET_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

export function isPlausibleBase64(value: unknown, maxEncodedLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxEncodedLength &&
    BASE64_CHARSET_PATTERN.test(value)
  );
}
