import { afterSearchNotFound, cleanName, IDLE, MAX_FOLLOW_UPS, parsePlace, PlannerAction, PlannerState, respond } from '../../src/core';

/**
 * Use case: the hiker asks OffGrid to plan a trip, but the place is unclear or
 * not found. Instead of failing, OffGrid asks follow-up questions (which
 * trail? what town and state? another name?) and keeps what was already said.
 */
const TRAILS = [{ id: 'blue-hills-great-blue-hill', name: 'Blue Hills: Great Blue Hill & Skyline Trail' }];
const NOW = new Date(2026, 10, 25, 12); // Wednesday

function expectAsk(a: PlannerAction): { question: string; state: PlannerState } {
  if (a.type !== 'ask') throw new Error(`expected a question, got ${a.type}`);
  return a;
}
function expectSearch(a: PlannerAction) {
  if (a.type !== 'search') throw new Error(`expected a search, got ${a.type}`);
  return a;
}

describe('Use case: OffGrid asks follow-up questions when it doesn\'t know the place', () => {
  it('opens a known trail straight away, no questions', () => {
    expect(respond(IDLE, 'plan Blue Hills for Saturday', TRAILS, NOW)).toMatchObject({ type: 'open', trailId: 'blue-hills-great-blue-hill' });
  });

  it('asks which trail when none was named, and remembers "Saturday" for later', () => {
    const q = expectAsk(respond(IDLE, 'plan something nice for Saturday', TRAILS, NOW));
    expect(q.question).toMatch(/Which trail or park/);
    const next = respond(q.state, 'Blue Hills', TRAILS, NOW);
    expect(next).toMatchObject({ type: 'open', trailId: 'blue-hills-great-blue-hill' });
    expect(next.type === 'open' && next.when.when).toBe('Saturday');
  });

  it('takes a bare name as the answer to "which trail?"', () => {
    const q = expectAsk(respond(IDLE, 'plan a trip for me', TRAILS, NOW));
    expect(expectSearch(respond(q.state, 'Ponkapoag Pond Trail', TRAILS, NOW)).name).toBe('Ponkapoag Pond Trail');
  });

  it('when not found nearby, asks for the town and state, then searches there', () => {
    const search = expectSearch(respond(IDLE, 'plan a hike at Ponkapoag Pond on Sunday', TRAILS, NOW));
    expect(search.near).toBeNull();
    const q = expectAsk(afterSearchNotFound(search));
    expect(q.question).toMatch(/couldn't find "Ponkapoag Pond" near Wellesley, MA\. What town and state is it in\?/);
    const again = expectSearch(respond(q.state, "It's in Canton, Massachusetts", TRAILS, NOW));
    expect(again).toMatchObject({ name: 'Ponkapoag Pond', near: 'Canton, MA' });
    expect(again.when.when).toBe('Sunday');
  });

  it('then asks for another name or the park, and searches that in the same town', () => {
    const s1 = expectSearch(respond(IDLE, 'hike at Ponky Pond', TRAILS, NOW));
    const s2 = expectSearch(respond(expectAsk(afterSearchNotFound(s1)).state, 'Canton MA', TRAILS, NOW));
    const q = expectAsk(afterSearchNotFound(s2));
    expect(q.question).toMatch(/another name, or what park or reservation/);
    expect(expectSearch(respond(q.state, "it's called Ponkapoag Pond", TRAILS, NOW))).toMatchObject({ name: 'Ponkapoag Pond', near: 'Canton, MA' });
  });

  it(`gives up politely after ${MAX_FOLLOW_UPS} questions instead of looping`, () => {
    let state: PlannerState = IDLE;
    let last: PlannerAction = respond(state, 'plan something', TRAILS, NOW);
    let questions = 0;
    while (last.type === 'ask') {
      questions++;
      state = last.state;
      last = respond(state, '???', TRAILS, NOW);
    }
    expect(questions).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    expect(last.type).toBe('give_up');
  });

  it('re-asks for the town if the answer isn\'t a place', () => {
    const s = expectSearch(respond(IDLE, 'hike at Ponky Pond', TRAILS, NOW));
    const q = expectAsk(afterSearchNotFound(s));
    expect(expectAsk(respond(q.state, '12345', TRAILS, NOW)).question).toMatch(/Which town and state/);
  });

  it('understands the ways people say a town and state', () => {
    expect(parsePlace('Canton, Massachusetts')).toBe('Canton, MA');
    expect(parsePlace("it's in canton ma")).toBe('Canton, MA');
    expect(parsePlace('near North Conway, New Hampshire.')).toBe('North Conway, NH');
    expect(parsePlace('Milton')).toBe('Milton, MA'); // Massachusetts assumed
    expect(parsePlace('<script>')).toBe('Script, MA'); // only letters survive
    expect(parsePlace('42')).toBeNull();
    expect(cleanName("it's called Ponkapoag Pond.")).toBe('Ponkapoag Pond');
    expect(cleanName('!!')).toBeNull();
  });
});
