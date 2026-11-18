import { LatLng } from '@offgrid/shared';

const EARTH_RADIUS_M = 6371000;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Approximate equirectangular-projection distance from a point to a line
 * segment. Adequate for the sub-kilometer segment lengths a trail route line
 * is made of; not meant for long-range geodesy.
 */
export function distanceToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const latRef = toRadians(a.lat);
  const xScale = Math.cos(latRef);
  const toXY = (pt: LatLng) => ({
    x: toRadians(pt.lng) * xScale * EARTH_RADIUS_M,
    y: toRadians(pt.lat) * EARTH_RADIUS_M,
  });
  const P = toXY(p);
  const A = toXY(a);
  const B = toXY(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = A.x + t * dx;
  const projY = A.y + t * dy;
  return Math.hypot(P.x - projX, P.y - projY);
}

export interface PolylineDistanceResult {
  distanceMeters: number;
  segmentIndex: number;
}

export function distanceToPolylineMeters(p: LatLng, line: LatLng[]): PolylineDistanceResult {
  if (line.length === 0) return { distanceMeters: Infinity, segmentIndex: -1 };
  if (line.length === 1) return { distanceMeters: haversineDistanceMeters(p, line[0]), segmentIndex: 0 };

  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const d = distanceToSegmentMeters(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { distanceMeters: best, segmentIndex: bestIdx };
}
