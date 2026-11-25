import { ApiError, describeFailure, installNetworkGuard, joinDictation, OfflineError, readinessFor } from '../../src/core';

/**
 * Use case: the app's small behaviours behave: dictation adds to what you've
 * said, offline mode is only ever switched by the button, and failures say
 * what actually went wrong.
 */
describe('Use case: speaking in pieces builds one request', () => {
  it('adds a second dictation to the first instead of replacing it (Ironhide: BUG-023)', () => {
    expect(joinDictation("I'm about to hike", 'in Blue Hills on Saturday')).toBe("I'm about to hike in Blue Hills on Saturday");
  });

  it("doesn't double words the speech engine repeats, and handles empty parts", () => {
    expect(joinDictation('plan Blue Hills', 'plan Blue Hills for Saturday')).toBe('plan Blue Hills for Saturday');
    expect(joinDictation('', 'hello')).toBe('hello');
    expect(joinDictation('hello ', '  ')).toBe('hello');
  });
});

describe('Use case: offline mode only changes when the button is pressed', () => {
  const fakeTarget = () => {
    const calls: string[] = [];
    const target = { fetch: (async (url: string) => (calls.push(String(url)), new Response('ok'))) as unknown as typeof fetch };
    return { target, calls };
  };

  it('blocks and counts requests only while offline, and is truly toggleable', async () => {
    const { target, calls } = fakeTarget();
    const guard = installNetworkGuard(target);
    await target.fetch('/a');
    guard.setOffline(true);
    await expect(target.fetch('/b')).rejects.toBeInstanceOf(OfflineError);
    expect(guard.blocked).toBe(1);
    guard.setOffline(false);
    await target.fetch('/c');
    guard.setOffline(true);
    expect(guard.blocked).toBe(0); // counter restarts each time you go offline
    guard.setOffline(false);
    await target.fetch('/d');
    expect(calls).toEqual(['/a', '/c', '/d']);
  });

  it('installs only once, so a reload can never leave a stale "offline" layer underneath (Ironhide: BUG-024)', async () => {
    const { target, calls } = fakeTarget();
    const first = installNetworkGuard(target);
    first.setOffline(true);
    const second = installNetworkGuard(target); // the app's code running again on a live reload
    expect(second).toBe(first);
    second.setOffline(false);
    await target.fetch('/after-reload');
    expect(calls).toEqual(['/after-reload']);
  });
});

describe('Use case: failures say what actually went wrong (Ironhide: BUG-025)', () => {
  it('tells OpenStreetMap trouble, the server being down, rate limits and offline mode apart', () => {
    const osm = describeFailure(new ApiError(502, 'openstreetmap_unavailable', 'overpass-api.de: HTTP 429'));
    expect(osm).toMatch(/OpenStreetMap's servers didn't answer \(overpass-api\.de: HTTP 429\)\. That's on their side, not offline mode/);
    expect(describeFailure(new TypeError('Failed to fetch'))).toMatch(/can't reach the OffGrid server/);
    expect(describeFailure(new ApiError(429, 'rate_limited'))).toMatch(/Too many requests/);
    expect(describeFailure(new OfflineError())).toMatch(/Go offline button is on/);
    const messages = [osm, describeFailure(new TypeError('x')), describeFailure(new ApiError(429, 'rate_limited')), describeFailure(new OfflineError())];
    expect(new Set(messages).size).toBe(4);
  });
});

describe('Use case: "you\'re ready to hike" only when everything is really on the phone', () => {
  const base = {
    trailName: 'Blue Hills',
    places: 7,
    sideTrails: 16,
    photosSaved: 12,
    photosTotal: 12,
    matchablePlaces: 3,
    hazards: 0,
    checkedAt: new Date(2026, 10, 25, 14, 41),
  };

  it('says ready, lists what was saved, and reminds them to keep the app open', () => {
    const r = readinessFor(base);
    expect(r.ready).toBe(true);
    expect(r.headline).toBe("You're ready to hike Blue Hills");
    expect(r.items.map((i) => i.text)).toEqual([
      'Trail map, 16 side trails and 7 places',
      '12 of 12 reference photos saved on this device',
      '"Where am I?" can match photos from 3 places',
      expect.stringMatching(/^Hazard reports as of .*2:41.* \(none reported\)$/),
    ]);
    expect(r.advice).toMatch(/Keep OffGrid open in the background.*don't close it/);
  });

  it("doesn't claim ready when photos failed to save, and says how to fix it", () => {
    const r = readinessFor({ ...base, photosSaved: 10 });
    expect(r.ready).toBe(false);
    expect(r.headline).toBe("Almost ready: 2 photos didn't save");
    expect(r.items[1]).toEqual({ ok: false, text: '10 of 12 reference photos saved on this device' });
    expect(r.advice).toMatch(/Open the trail again while you still have signal/);
  });

  it('is honest about trails with no photos', () => {
    const r = readinessFor({ ...base, photosSaved: 0, photosTotal: 0, matchablePlaces: 0, sideTrails: 0, places: 3, hazards: 1 });
    expect(r.ready).toBe(true);
    expect(r.items.map((i) => i.text)).toEqual([
      'Trail map and 3 places',
      'No reference photos for this trail yet',
      expect.stringMatching(/needs reference photos/),
      expect.stringMatching(/\(1 reported hazard\)/),
    ]);
  });
});
