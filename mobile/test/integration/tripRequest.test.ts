import { parseTripRequest } from '../../src/core';

/**
 * Use case: a hiker says (or types) what they want, e.g. "I'm about to hike
 * Blue Hills this Saturday, can you plan a trip for me?", and the app figures
 * out which trail and when, so it can download it and show that season's photos.
 */
const TRAILS = [
  { id: 'blue-hills-great-blue-hill', name: 'Blue Hills: Great Blue Hill & Skyline Trail' },
  { id: 'shadow-creek-loop', name: 'Shadow Creek Loop' },
];
// Thursday 19 Nov 2026, noon local.
const NOW = new Date(2026, 10, 19, 12);

describe('Use case: plan a trip by saying it', () => {
  it('finds Blue Hills from a natural sentence, with the day and its season', () => {
    const r = parseTripRequest("Hey, I'm about to hike in Blue Hills this Saturday, can you plan a trip for me?", TRAILS, NOW);
    expect(r.trailId).toBe('blue-hills-great-blue-hill');
    expect(r.when).toBe('Saturday');
    expect(r.date!.getDate()).toBe(21);
    expect(r.season).toBe('fall');
  });

  it('matches on a distinctive word too ("Skyline", "Shadow Creek")', () => {
    expect(parseTripRequest('plan the skyline hike', TRAILS, NOW).trailId).toBe('blue-hills-great-blue-hill');
    expect(parseTripRequest('Shadow Creek tomorrow please', TRAILS, NOW).trailId).toBe('shadow-creek-loop');
  });

  it("doesn't match a trail on generic words alone", () => {
    const r = parseTripRequest('plan a hike at Rocky Ledges trail', TRAILS, NOW);
    expect(r.trailId).toBeNull();
    expect(r.searchName).toBe('Rocky Ledges trail');
  });

  it('pulls out an unknown trail name to look up on OpenStreetMap', () => {
    expect(parseTripRequest('Can you plan a trip to Elm Bank next week?', TRAILS, NOW).searchName).toBe('Elm Bank');
    expect(parseTripRequest('I want to hike Centennial Reservation on Sunday', TRAILS, NOW).searchName).toBe('Centennial Reservation');
  });

  it('understands common ways of saying when, and picks the season', () => {
    const when = (s: string) => parseTripRequest(s, TRAILS, NOW);
    expect(when('Blue Hills tomorrow').when).toBe('tomorrow');
    expect(when('Blue Hills this weekend').date!.getDay()).toBe(6);
    expect(when('Blue Hills in January').season).toBe('winter');
    expect(when('Blue Hills in January').date!.getUTCFullYear()).toBe(2027); // already past this year
    expect(when('Blue Hills on July 4').when).toBe('July 4');
    expect(when('Blue Hills on July 4').season).toBe('summer');
    expect(when('Blue Hills next Saturday').date!.getDate()).toBe(28);
    expect(when('Blue Hills').date).toBeNull();
  });

  it('does not read "may" in "may I" as the month of May', () => {
    expect(parseTripRequest('May I hike Blue Hills tomorrow?', TRAILS, NOW).when).toBe('tomorrow');
  });

  it('only ever proposes a search name the import endpoint will accept', () => {
    const r = parseTripRequest('hike at <script>alert(1)</script> trail', TRAILS, NOW);
    if (r.searchName) expect(r.searchName).toMatch(/^[A-Za-z0-9 .'&-]{2,60}$/);
    expect(parseTripRequest('x'.repeat(5000), TRAILS, NOW).searchName ?? '').not.toMatch(/x{61}/);
  });
});
