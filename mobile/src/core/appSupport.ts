/**
 * Small, testable pieces of app behaviour (kept here, not in app/App.tsx,
 * so they have tests): dictation, the "Go offline" network guard, and
 * honest failure messages.
 */

/**
 * Adds a new dictation to what's already in the box (BUG-023: speaking again
 * used to replace the earlier half-sentence). Some speech engines repeat
 * the earlier words at the start of a new session; those aren't doubled.
 */
export function joinDictation(existing: string, spoken: string): string {
  const base = existing.trim();
  const add = spoken.trim().replace(/\s+/g, ' ');
  if (!add) return base;
  if (!base) return add;
  if (add.toLowerCase().startsWith(base.toLowerCase())) return add;
  return `${base} ${add}`;
}

export class OfflineError extends Error {
  constructor() {
    super('Offline (the Go offline button is on)');
    this.name = 'OfflineError';
  }
}

export interface NetworkGuard {
  readonly offline: boolean;
  readonly blocked: number;
  setOffline(offline: boolean): void;
  subscribe(listener: () => void): () => void;
}

const GUARD = Symbol.for('offgrid.networkGuard');

/**
 * The "Go offline" button: wraps `target.fetch` so that, while offline, every
 * request is blocked (and counted) instead of sent. Offline changes ONLY via
 * setOffline(), i.e. the button.
 *
 * Installs exactly once per `target` (BUG-024): on a live reload the app's
 * code runs again, and wrapping the already-wrapped fetch left an old layer
 * (with its own, possibly still "offline", state) underneath.
 */
export function installNetworkGuard(target: { fetch: typeof fetch }): NetworkGuard {
  const t = target as unknown as Record<symbol, NetworkGuard | undefined>;
  const existing = t[GUARD];
  if (existing) return existing;

  const realFetch = target.fetch.bind(target);
  let offline = false;
  let blocked = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const guard: NetworkGuard = {
    get offline() {
      return offline;
    },
    get blocked() {
      return blocked;
    },
    setOffline(value: boolean) {
      offline = value;
      if (value) blocked = 0;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  target.fetch = ((...args: Parameters<typeof fetch>) => {
    if (offline) {
      blocked++;
      notify();
      return Promise.reject(new OfflineError());
    }
    return realFetch(...args);
  }) as typeof fetch;
  t[GUARD] = guard;
  return guard;
}

/** An error the OffGrid API returned (it answered, but said no). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * What to tell the hiker when a planner request fails. BUG-025: every failure
 * used to read "I can't reach OpenStreetMap right now", including the OffGrid
 * server not running and OffGrid's own rate limit, which looked like being
 * stuck offline.
 */
export function describeFailure(err: unknown): string {
  if (err instanceof OfflineError) {
    return 'You\'re in offline mode (the Go offline button is on). Press "Back online" to plan.';
  }
  if (err instanceof ApiError) {
    if (err.code === 'openstreetmap_unavailable') {
      return (
        `OpenStreetMap's servers didn't answer${err.detail ? ` (${err.detail})` : ''}. ` +
        "That's on their side, not offline mode. Try again in a minute."
      );
    }
    if (err.code === 'rate_limited' || err.status === 429) {
      return 'Too many requests in a short time. Wait a minute, then try again.';
    }
    return `The OffGrid server said no (${err.code}).`;
  }
  return "I can't reach the OffGrid server. Is it still running (npm run preview or npm run dev:backend)?";
}
