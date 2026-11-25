import { Season } from '@offgrid/shared';
import { KnownTrail, parseTripRequest } from './tripRequest';

/**
 * The "Plan a trip" conversation. When OffGrid can't tell or can't find the
 * place, it asks follow-up questions instead of failing:
 *   no trail named      -> "Which trail or park are you hiking?"
 *   not found nearby    -> "What town and state is it in?"
 *   still not found     -> "Does it have another name, or what park is it in?"
 * After MAX_FOLLOW_UPS it stops and says how to rephrase, so it never loops.
 * Plain rules, no AI; what the hiker said about WHEN is kept across turns.
 */

export const MAX_FOLLOW_UPS = 3;
export const DEFAULT_AREA = 'Wellesley, MA';

export interface WhenInfo {
  date: Date | null;
  when: string | null;
  season: Season | null;
}

export type PlannerState =
  | { step: 'idle' }
  | { step: 'need_trail'; when: WhenInfo; asked: number }
  | { step: 'need_town'; name: string; when: WhenInfo; asked: number }
  | { step: 'need_detail'; name: string; near: string; when: WhenInfo; asked: number };

export type PlannerAction =
  | { type: 'open'; trailId: string; when: WhenInfo }
  /** Look the trail up on OpenStreetMap; then call afterSearchNotFound(...) if it isn't there. */
  | { type: 'search'; name: string; near: string | null; when: WhenInfo; asked: number }
  | { type: 'ask'; question: string; state: PlannerState }
  | { type: 'give_up'; message: string };

export const IDLE: PlannerState = { step: 'idle' };

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const ABBRS = new Set(Object.values(US_STATES));
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "it's in Canton, Massachusetts" / "Canton MA" / "canton" -> "Canton, MA" (Massachusetts assumed if no state). */
export function parsePlace(text: string): string | null {
  let t = (text ?? '')
    .slice(0, 120)
    .replace(/[^A-Za-z .,'-]/g, ' ')
    .replace(/^\s*(?:(?:it'?s|it is|its|located|somewhere|i think|maybe|the town of|town of|city of|in|near|by|around)\s+)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
  let state: string | null = null;
  for (const [name, abbr] of Object.entries(US_STATES)) {
    const re = new RegExp(`[ ,]+${name}$`, 'i');
    if (re.test(t)) {
      state = abbr;
      t = t.replace(re, '');
      break;
    }
  }
  if (!state) {
    const m = /[ ,]+([A-Za-z]{2})\.?$/.exec(t);
    if (m && ABBRS.has(m[1].toUpperCase())) {
      state = m[1].toUpperCase();
      t = t.slice(0, m.index);
    }
  }
  const town = t.replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z][A-Za-z .'-]{1,39}$/.test(town)) return null;
  return `${titleCase(town)}, ${state ?? 'MA'}`;
}

/** A trail/park name from a short answer like "it's called Ponkapoag Pond Trail". */
export function cleanName(text: string): string | null {
  const t = (text ?? '')
    .slice(0, 120)
    .replace(/^\s*(?:(?:it'?s|it is|its|called|named|the|maybe|try|i think|i mean|it's called)\s+)+/i, '')
    .replace(/[^A-Za-z0-9 .'&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
  return t.length >= 2 && t.length <= 60 ? t : null;
}

const mergeWhen = (before: WhenInfo, now: WhenInfo): WhenInfo => (now.when ? now : before);
const whenOf = (r: { date: Date | null; when: string | null; season: Season | null }): WhenInfo => ({
  date: r.date,
  when: r.when,
  season: r.season,
});

function askOrGiveUp(asked: number, question: string, state: PlannerState): PlannerAction {
  if (asked >= MAX_FOLLOW_UPS) {
    return {
      type: 'give_up',
      message:
        "Sorry, I still can't find it. Try the trail's name exactly as it appears on a map, for example \"Skyline Trail\" or \"Rocky Ledges\", or add it under Add a trail.",
    };
  }
  return { type: 'ask', question, state };
}

/** What to do with the hiker's latest message, given what OffGrid last asked. */
export function respond(state: PlannerState, text: string, trails: KnownTrail[], now: Date = new Date()): PlannerAction {
  const req = parseTripRequest(text, trails, now);

  if (state.step === 'idle' || state.step === 'need_trail') {
    const when = state.step === 'idle' ? whenOf(req) : mergeWhen(state.when, whenOf(req));
    const asked = state.step === 'idle' ? 0 : state.asked;
    if (req.trailId) return { type: 'open', trailId: req.trailId, when };
    // A follow-up answer is usually just the name ("Rocky Ledges"), with no "hike at …" around it.
    const name = req.searchName ?? (state.step === 'need_trail' ? cleanName(text) : null);
    if (name) return { type: 'search', name, near: null, when, asked };
    return askOrGiveUp(
      asked,
      'Which trail or park are you hiking? For example, "Blue Hills" or "Rocky Ledges".',
      { step: 'need_trail', when, asked: asked + 1 },
    );
  }

  if (state.step === 'need_town') {
    const when = mergeWhen(state.when, whenOf(req));
    if (req.trailId) return { type: 'open', trailId: req.trailId, when };
    const near = parsePlace(text);
    if (!near) {
      return askOrGiveUp(state.asked, 'Which town and state is it in? For example, "Canton, Massachusetts".', {
        ...state,
        when,
        asked: state.asked + 1,
      });
    }
    return { type: 'search', name: state.name, near, when, asked: state.asked };
  }

  // need_detail: another name for it, or the park/reservation it's in.
  const when = mergeWhen(state.when, whenOf(req));
  if (req.trailId) return { type: 'open', trailId: req.trailId, when };
  const name = cleanName(text);
  if (!name) {
    return askOrGiveUp(state.asked, 'What else is it called, or what park or reservation is it in?', {
      ...state,
      when,
      asked: state.asked + 1,
    });
  }
  return { type: 'search', name, near: state.near, when, asked: state.asked };
}

/** The search found nothing: ask the next, more specific question. */
export function afterSearchNotFound(search: Extract<PlannerAction, { type: 'search' }>): PlannerAction {
  const asked = search.asked + 1;
  if (!search.near) {
    return askOrGiveUp(
      search.asked,
      `I couldn't find "${search.name}" near ${DEFAULT_AREA}. What town and state is it in?`,
      { step: 'need_town', name: search.name, when: search.when, asked },
    );
  }
  return askOrGiveUp(
    search.asked,
    `I couldn't find "${search.name}" near ${search.near}. Does it have another name, or what park or reservation is it in?`,
    { step: 'need_detail', name: search.name, near: search.near, when: search.when, asked },
  );
}
