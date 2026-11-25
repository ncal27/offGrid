import { NearbyTrail } from '@offgrid/shared';
import { parsePlace } from './tripPlannerDialog';

/**
 * "I'm looking for a hiking place near Needham": find the request, the town,
 * the radius ("within 3 miles", default 5), and how to rank the results
 * (closest, longest, shortest, easiest, hardest, quickest). Then help pick
 * one by number ("number 2", "the second one") or by name.
 */

export type SortKey = 'closest' | 'longest' | 'shortest' | 'easiest' | 'hardest' | 'quickest';
export const DEFAULT_RADIUS_MILES = 5;
export const MAX_RADIUS_MILES = 15;
export const METERS_PER_MILE = 1609.344;

export interface DiscoveryRequest {
  /** "Needham, MA", or null if no town was given (e.g. "near me"). */
  near: string | null;
  radiusMiles: number;
  sort: SortKey;
}

const DISCOVERY = /\b(looking for|look for|find|search|suggest|recommend|show me|any|what are|what about|how about|where can i|options?|ideas?|good)\b/i;
const OUTDOORS = /\b(hik\w*|trails?|walks?|spots?|places?|parks?|nature)\b/i;
const NEAR = /\b(?:near|around|close to|nearby|by|in|outside(?: of)?)\s+([A-Za-z][A-Za-z .,'-]{1,60})/i;
const PLACE_END = /\b(within|for|this|next|on|tomorrow|today|that|which|with|please|sorted|by distance|ranked|instead|then|too|maybe)\b|[.?!]/i;

export function parseSort(text: string): SortKey | null {
  const t = text.toLowerCase();
  if (/\b(longest|longer|long ones?|long hikes?)\b/.test(t)) return 'longest';
  if (/\b(shortest|shorter|short ones?|short hikes?)\b/.test(t)) return 'shortest';
  if (/\b(hardest|harder|difficult|challenging|tough|toughest|hard ones?)\b/.test(t)) return 'hardest';
  if (/\b(easiest|easier|easy|beginner|kid|family|gentle)\b/.test(t)) return 'easiest';
  if (/\b(quickest|quick|fastest|least time|short on time)\b/.test(t)) return 'quickest';
  if (/\b(closest|nearest|close by)\b/.test(t)) return 'closest';
  return null;
}

/** null if the text isn't a "find hiking places near …" request. */
export function parseDiscovery(text: string): DiscoveryRequest | null {
  const t = (text ?? '').slice(0, 300);
  const radius = /\bwithin\s+(\d+(?:\.\d+)?)\s*(mi|miles?|km|kilometers?)\b/i.exec(t);
  const nearHit = NEAR.exec(t);
  const isDiscovery = OUTDOORS.test(t) && (DISCOVERY.test(t) || !!radius) && (!!nearHit || !!radius || /\bnear me\b/i.test(t));
  if (!isDiscovery) return null;

  let radiusMiles = DEFAULT_RADIUS_MILES;
  if (radius) {
    const n = Number(radius[1]);
    radiusMiles = /^k/i.test(radius[2]) ? n / 1.609344 : n;
  }
  radiusMiles = Math.min(MAX_RADIUS_MILES, Math.max(1, Math.round(radiusMiles * 10) / 10));

  let near: string | null = null;
  if (nearHit && !/^me\b/i.test(nearHit[1])) near = parsePlace(nearHit[1].split(PLACE_END)[0]);
  return { near, radiusMiles, sort: parseSort(t) ?? 'closest' };
}

const DIFF_RANK = { easy: 0, moderate: 1, hard: 2 } as const;

export function sortTrails(list: NearbyTrail[], sort: SortKey): NearbyTrail[] {
  const by: Record<SortKey, (a: NearbyTrail, b: NearbyTrail) => number> = {
    closest: (a, b) => a.distanceFromCenterMeters - b.distanceFromCenterMeters,
    longest: (a, b) => b.lengthMeters - a.lengthMeters,
    shortest: (a, b) => a.lengthMeters - b.lengthMeters,
    easiest: (a, b) => a.difficultyScore - b.difficultyScore || a.lengthMeters - b.lengthMeters,
    hardest: (a, b) => b.difficultyScore - a.difficultyScore || b.lengthMeters - a.lengthMeters,
    quickest: (a, b) => a.estimatedMinutes - b.estimatedMinutes,
  };
  return [...list].sort(by[sort]);
}

const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1, top: 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5,
  sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10,
};

/** Which result the hiker picked (index into `list`), or null. */
export function parseChoice(text: string, list: NearbyTrail[]): number | null {
  const t = (text ?? '').toLowerCase();
  const num = /\b(?:number|no\.?|#|option|trail)\s*(\d{1,2})\b/.exec(t) ?? /^\s*(\d{1,2})\s*$/.exec(t);
  if (num) {
    const i = Number(num[1]) - 1;
    return i >= 0 && i < list.length ? i : null;
  }
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t) && n <= list.length) return n - 1;
  }
  // By name: the result sharing the most distinctive words with what was said.
  const words = new Set(t.replace(/[^a-z0-9' ]/g, ' ').split(/\s+/));
  const generic = new Set(['trail', 'path', 'loop', 'the', 'pond', 'park', 'hill', 'brook', 'reservation', 'woods']);
  let best: { i: number; score: number } | null = null;
  list.forEach((trail, i) => {
    const hits = trail.name.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && words.has(w));
    const score = hits.filter((w) => !generic.has(w)).length * 2 + hits.length;
    if (hits.some((w) => !generic.has(w)) && (!best || score > best.score)) best = { i, score };
  });
  return best ? (best as { i: number }).i : null;
}

export const miles = (m: number) => (m / METERS_PER_MILE).toFixed(1);
export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.max(5, Math.round(min / 5) * 5)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 5) * 5;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const SORT_WORDS: Record<SortKey, string> = {
  closest: 'closest first',
  longest: 'longest first',
  shortest: 'shortest first',
  easiest: 'easiest first',
  hardest: 'hardest first',
  quickest: 'quickest first',
};

/** What OffGrid says about a result list (the app also shows all of them). */
export function describeResults(list: NearbyTrail[], near: string, radiusMiles: number, sort: SortKey): string {
  if (list.length === 0) {
    return `I didn't find any named trails within ${radiusMiles} miles of ${near}. Try a bigger radius, like "within 10 miles", or another town.`;
  }
  const top = list
    .slice(0, 3)
    .map((t, i) => `${i + 1}, ${t.name}: ${miles(t.lengthMeters)} miles, about ${formatMinutes(t.estimatedMinutes)}, ${t.difficulty}`)
    .join('; ');
  return (
    `Here are ${list.length} trail${list.length === 1 ? '' : 's'} within ${radiusMiles} miles of ${near}, ${SORT_WORDS[sort]}. ${top}. ` +
    `Say "longest", "shortest", "easiest", "hardest" or "quickest" to sort, or say a name or number to plan one.`
  );
}
