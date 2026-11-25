import { NearbyTrail } from '@offgrid/shared';
import { describeResults, formatMinutes, IDLE, parseChoice, parseDiscovery, PlannerAction, respond, showResults, sortTrails } from '../../src/core';

/**
 * Use case: "I'm looking for a hiking place near Needham." OffGrid lists the
 * named trails within a radius (5 miles by default), ranks them by what the
 * hiker cares about (closest, longest, shortest, easiest, hardest, quickest),
 * and lets them pick one by number or name to plan it.
 */
const trail = (name: string, mi: number, away: number, difficulty: NearbyTrail['difficulty'], score: number): NearbyTrail => ({
  name,
  lengthMeters: mi * 1609.344,
  distanceFromCenterMeters: away * 1609.344,
  difficulty,
  difficultyScore: score,
  estimatedMinutes: (mi / 2) * 60 * (1 + score * 0.1),
  center: { lat: 42.28, lng: -71.23 },
});
const RESULTS = [
  trail('Charles River Peninsula Trail', 1.2, 0.8, 'easy', 0.5),
  trail('Needham Town Forest Loop', 2.6, 1.5, 'moderate', 1.4),
  trail('Noanet Woodlands Caryl Trail', 4.8, 3.9, 'hard', 2.6),
  trail('Rosemary Lake Path', 0.6, 0.4, 'easy', 0.2),
];
const TRAILS = [{ id: 'blue-hills-great-blue-hill', name: 'Blue Hills: Great Blue Hill & Skyline Trail' }];
const NOW = new Date(2026, 10, 25, 12);

describe('Use case: find hiking places near a town, ranked', () => {
  it('recognises "looking for a hiking place near Needham" (5 miles by default)', () => {
    expect(parseDiscovery("I'm looking for a hiking place near Needham")).toEqual({ near: 'Needham, MA', radiusMiles: 5, sort: 'closest' });
  });

  it('picks up a radius and a ranking preference', () => {
    expect(parseDiscovery('find the longest hikes within 3 miles of Dover, Massachusetts')).toMatchObject({ radiusMiles: 3, sort: 'longest' });
    expect(parseDiscovery('any easy trails around Wellesley within 8 km')).toMatchObject({ near: 'Wellesley, MA', radiusMiles: 5, sort: 'easiest' });
    expect(parseDiscovery('trails near Needham within 99 miles')!.radiusMiles).toBe(15); // capped
  });

  it('is not triggered by planning a specific trail', () => {
    expect(parseDiscovery('plan a hike at Rocky Ledges tomorrow')).toBeNull();
  });

  it('asks which town for "near me" (no location yet), then searches there', () => {
    const q = respond(IDLE, 'find hiking spots near me', TRAILS, NOW);
    expect(q.type).toBe('ask');
    const next = respond((q as Extract<PlannerAction, { type: 'ask' }>).state, 'Needham', TRAILS, NOW);
    expect(next).toMatchObject({ type: 'discover', near: 'Needham, MA', radiusMiles: 5 });
  });

  it('ranks by each preference', () => {
    const names = (s: Parameters<typeof sortTrails>[1]) => sortTrails(RESULTS, s).map((t) => t.name.split(' ')[0]);
    expect(names('closest')[0]).toBe('Rosemary');
    expect(names('longest')[0]).toBe('Noanet');
    expect(names('shortest')[0]).toBe('Rosemary');
    expect(names('hardest')[0]).toBe('Noanet');
    expect(names('easiest')[0]).toBe('Rosemary');
    expect(names('quickest')[0]).toBe('Rosemary');
  });

  it('describes the list out loud, with distance, time and difficulty', () => {
    const msg = describeResults(sortTrails(RESULTS, 'longest'), 'Needham, MA', 5, 'longest');
    expect(msg).toMatch(/Here are 4 trails within 5 miles of Needham, MA, longest first\. 1, Noanet Woodlands Caryl Trail: 4\.8 miles, about 3 h, hard/);
    expect(describeResults([], 'Needham, MA', 5, 'closest')).toMatch(/didn't find any named trails within 5 miles/);
    expect(formatMinutes(42)).toBe('40 min');
  });

  it('lets the hiker re-sort and then pick by number, ordinal or name', () => {
    const shown = showResults({ type: 'discover', near: 'Needham, MA', radiusMiles: 5, sort: 'closest', when: { date: null, when: null, season: null } }, RESULTS);
    const hardest = respond(shown.state, 'show me the hardest ones', TRAILS, NOW);
    expect(hardest.type).toBe('show');
    const state = (hardest as Extract<PlannerAction, { type: 'show' }>).state;
    expect(state.results[0].name).toMatch(/Noanet/);
    expect(respond(state, 'number 2', TRAILS, NOW)).toMatchObject({ type: 'pick', trail: { name: state.results[1].name }, near: 'Needham, MA' });
    expect(respond(state, "let's do the first one", TRAILS, NOW)).toMatchObject({ type: 'pick', trail: { name: state.results[0].name } });
    expect(respond(state, 'the Rosemary one', TRAILS, NOW)).toMatchObject({ type: 'pick', trail: { name: 'Rosemary Lake Path' } });
    expect(respond(state, 'number 9', TRAILS, NOW).type).not.toBe('pick'); // out of range
  });

  it('can switch towns from the result list', () => {
    const shown = showResults({ type: 'discover', near: 'Needham, MA', radiusMiles: 5, sort: 'closest', when: { date: null, when: null, season: null } }, RESULTS);
    expect(respond(shown.state, 'what about hiking places near Dover instead', TRAILS, NOW)).toMatchObject({ type: 'discover', near: 'Dover, MA' });
  });

  it('only picks by name on a distinctive word, not "trail" or "path"', () => {
    expect(parseChoice('the trail one', RESULTS)).toBeNull();
  });
});
