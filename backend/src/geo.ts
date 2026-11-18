import { LatLng } from '@offgrid/shared';

const EARTH_RADIUS_M = 6371000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Small standalone copy of the same haversine formula used in
 * mobile/src/core/geo.ts. Not yet consolidated into packages/shared —
 * cross-cutting refactors of already-reviewed logic are being deferred until
 * the test suite has actually been run for real at least once (see
 * docs/BUGS.md for why that caveat matters here), rather than risking a
 * shared-module change that can't be verified end to end this session.
 */
export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
