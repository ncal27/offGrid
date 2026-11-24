import { Season, seasonOf } from '@offgrid/shared';

/**
 * Understands a spoken or typed trip request, e.g.
 *   "I'm about to hike Blue Hills this Saturday, can you plan a trip for me?"
 * and pulls out WHICH trail and WHEN (so the app can show photos from that
 * season). Deliberately simple and predictable (keyword rules, no AI) so it's
 * easy to test and explain. Speech-to-text happens before this, on the device.
 */

export interface KnownTrail {
  id: string;
  name: string;
}

export interface TripRequest {
  /** A trail from the list that the request clearly names. */
  trailId: string | null;
  /** Otherwise, the trail name to look up on OpenStreetMap (already safe for the import endpoint). */
  searchName: string | null;
  date: Date | null;
  /** Human words for the date, e.g. "Saturday", "tomorrow", "October". */
  when: string | null;
  season: Season | null;
}

// Words that don't identify a trail by themselves.
const GENERIC = new Set([
  'the', 'a', 'an', 'and', 'of', 'trail', 'trails', 'loop', 'path', 'paths', 'hill', 'hills', 'reservation', 'park',
  'state', 'forest', 'great', 'little', 'mount', 'mt', 'north', 'south', 'east', 'west',
]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Best known trail named in the text: needs at least one distinctive word, or two generic ones (e.g. "Blue Hills"). */
function matchKnownTrail(text: string, trails: KnownTrail[]): string | null {
  const words = new Set(tokens(text));
  let best: { id: string; score: number } | null = null;
  for (const t of trails) {
    const nameWords = [...new Set(tokens(t.name))];
    const hits = nameWords.filter((w) => words.has(w));
    const distinctive = hits.filter((w) => !GENERIC.has(w)).length;
    if (distinctive === 0 && hits.length < 2) continue;
    const score = distinctive * 2 + hits.length;
    if (!best || score > best.score) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

// Where a trail name usually ends in a sentence.
const STOP = /\b(this|next|on|tomorrow|today|tonight|in|for|please|can|could|and|with|around|at|so|then|i'm|im|i)\b|[,.?!]/i;
const LEAD = /\b(?:hike|hiking|walk|walking|visit|trip|go|going|head|heading|explore|in|at|to)\s+([A-Za-z0-9][A-Za-z0-9 .'&-]{1,59})/gi;
// Filler between the lead-in word and the name: "hike AT the …", "to HIKE …", "trip TO …".
const FILLER = /^(?:(?:a|an|the|hike|hiking|trip|walk|to|in|at|on|up|around|me|my)\s+)+/i;

/** Pulls a trail name out of the sentence for an OpenStreetMap lookup. */
function extractName(text: string): string | null {
  for (const m of text.matchAll(LEAD)) {
    const candidate = m[1].replace(FILLER, '').split(STOP)[0].trim().replace(/\s+/g, ' ');
    const words = tokens(candidate).filter((w) => !['a', 'trip', 'hike', 'me', 'my'].includes(w));
    if (words.length === 0 || words.length > 5) continue;
    if (/^(the )?(woods|mountains?|trails?|park)$/i.test(candidate)) continue;
    const clean = candidate.replace(/[^A-Za-z0-9 .'&-]/g, '').trim();
    if (clean.length >= 2) return clean;
  }
  return null;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function parseWhen(text: string, now: Date): { date: Date; when: string } | null {
  const t = text.toLowerCase();
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  if (/\b(today|tonight|right now|now)\b/.test(t)) return { date: now, when: 'today' };
  if (/\btomorrow\b/.test(t)) return { date: at(1), when: 'tomorrow' };
  const inDays = /\bin (\d{1,2}) days?\b/.exec(t);
  if (inDays) return { date: at(Number(inDays[1])), when: `in ${inDays[1]} days` };
  if (/\bnext week\b/.test(t)) return { date: at(7), when: 'next week' };
  if (/\b(this )?weekend\b/.test(t)) {
    const d = (6 - now.getDay() + 7) % 7;
    return { date: at(d), when: 'this weekend' };
  }
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DAYS[i]}\\b`).test(t)) {
      const d = (i - now.getDay() + 7) % 7 || 7; // "Saturday" on a Saturday means next week's
      return { date: at(/\bnext\b/.test(t) && d < 7 ? d + 7 : d), when: cap(DAYS[i]) };
    }
  }
  for (let m = 0; m < 12; m++) {
    const re = new RegExp(`\\b${MONTHS[m]}\\b(?:\\s+(\\d{1,2}))?`);
    const hit = re.exec(t);
    if (hit) {
      // May is also a word ("may I"); only take it with a day number or "in May".
      if (m === 4 && !hit[1] && !/\bin may\b/.test(t)) continue;
      const year = m < now.getMonth() || (m === now.getMonth() && hit[1] && Number(hit[1]) < now.getDate()) ? now.getFullYear() + 1 : now.getFullYear();
      return { date: new Date(Date.UTC(year, m, hit[1] ? Number(hit[1]) : 15, 12)), when: hit[1] ? `${cap(MONTHS[m])} ${hit[1]}` : cap(MONTHS[m]) };
    }
  }
  return null;
}

export function parseTripRequest(text: string, trails: KnownTrail[], now: Date = new Date()): TripRequest {
  const input = (text ?? '').slice(0, 300); // a spoken sentence, not an essay
  const trailId = matchKnownTrail(input, trails);
  const searchName = trailId ? null : extractName(input);
  const w = parseWhen(input, now);
  return {
    trailId,
    searchName,
    date: w?.date ?? null,
    when: w?.when ?? null,
    season: w ? seasonOf(w.date) : null,
  };
}
