# OffGrid Bug Log

A running record of bugs found and how they were fixed, kept separate from
`docs/roadmap.md` (which tracks *unbuilt* features, not defects in what
exists). Add an entry here any time a bug is found, whether by running the
test suite for real or by manual code review (this repo has spent its whole
life so far in environments where the shell needed to actually run
`npm test` was unavailable — see the note on every entry for how it was
caught instead).

## Review log

| Date | Scope | Outcome |
| --- | --- | --- |
| 2026-11-16 | V1: shared types, backend (trail search/package/contributions), mobile core (navigator, matcher, sync queue) + their integration tests | Found and fixed BUG-001 |
| 2026-11-18 | V2: landmarkPhotoService + trailService refactor to mutable stores, contribution promotion pipeline, trail version/update-check flow, hazard reporting MVP, OfflineUploadQueue extraction, and all new integration tests | No new bugs found; traced type-narrowing, Express route ordering, module-isolation-per-test-file assumptions, and the promotion/corroboration math by hand |
| 2026-11-18 (later) | Input validation/sanitization layer: shared validators, backend image validation, request validation wired into contribution/hazard routes, volume caps, JSON error handling, mobile pre-validation | Found and fixed BUG-002 and BUG-003 while writing tests for the new validation, before ever running them |

## Open

_None currently._

## Fixed

### BUG-003 — new image-signature validation would have rejected every existing contribution test's placeholder photo

- **Found:** 2026-11-18, while adding real image validation (magic-byte
  signature checks) to `backend/src/validation/imageValidation.ts`.
- **Where:** `backend/test/integration/contributionSync.test.ts` and
  `backend/test/integration/promotionPipeline.test.ts`.
- **What happened:** Both files used the same placeholder
  `imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw=='` (base64 for the plain text
  `"fake-image-bytes"`), written before any image validation existed. Once
  `validateContributedPhotoUploadBody()` started requiring a recognized
  jpeg/png/webp magic-byte signature, every test that POSTs to
  `/contributions/photos` with that placeholder would have started
  returning `400 invalid_request` instead of the `202`/`pending_review`/
  `promoted` responses those tests actually assert — not a bug in the new
  validator (it was correctly rejecting non-image data), but a real
  regression in previously-passing tests that a confident "found no bugs"
  review could easily have missed by only looking at the new code.
- **Fix:** Replaced the placeholder in both files with a real (tiny,
  synthetic) JPEG-signed payload: `Buffer.concat([Buffer.from([0xff, 0xd8,
  0xff]), Buffer.alloc(16, 1)]).toString('base64')`. Mobile tests using the
  same old placeholder string (`reconnectSync.test.ts`,
  `queueValidation.test.ts`) were deliberately left unchanged — they only
  exercise the mobile-side charset-only pre-check, which that string always
  passed and was always meant to test.
- **How it was caught:** Grepping for every usage of the placeholder string
  across the repo before trusting the new validator was "done," specifically
  because adding a stricter validator is exactly the kind of change that
  silently breaks existing callers.

### BUG-002 — request body size limit was smaller than the validator's own image-size cap

- **Found:** 2026-11-18, while writing a test for "decoded image exceeds the
  8MB cap."
- **Where:** `backend/src/app.ts` (`express.json({ limit: '10mb' })`) vs.
  `backend/src/validation/imageValidation.ts`'s `MAX_DECODED_IMAGE_BYTES`
  (8MB).
- **What happened:** Base64 encoding inflates binary size by about a third.
  An image right at the intended 8MB cap needs roughly 10.7MB of base64
  text alone, before accounting for the rest of the JSON body — which is
  larger than the global 10MB request body limit. A legitimately-sized photo
  near the cap would have been rejected by Express's blunt `413` *before*
  ever reaching the new, more informative `400` validation response, making
  the carefully-worded validator error effectively unreachable for exactly
  the size range it was meant to describe.
- **Fix:** Raised the global body limit to `15mb` in `createApp()`, with a
  comment explaining the base64-inflation math so it doesn't get "optimized"
  back down without accounting for it again.
- **How it was caught:** Trying to actually construct a test case for the
  8MB boundary and noticing the numbers didn't fit — a good example of why
  writing the test is itself a form of review, not just a formality after
  the code is "done."

### BUG-001 — `reached_waypoint` test asserted the event fires twice at an unchanged position

- **Found:** 2026-11-16, during V1 build.
- **Where:** `mobile/test/integration/planAndNavigateOffline.test.ts`.
- **What happened:** The test called `OfflineNavigator.processFix()` twice in
  a row with the exact same GPS fix sitting right on top of a waypoint, and
  asserted `reached_waypoint` would appear in the event list both times.
  `OfflineNavigator` tracks `reachedWaypoints` in a `Set` specifically so the
  event only fires once per waypoint per navigator instance (so a UI
  wouldn't re-announce "you reached the creek crossing!" on every GPS tick
  while standing still) — so the second assertion would have failed.
- **Fix:** Rewrote the test to assert `on_route` + `reached_waypoint` both
  fire on the *first* fix at that location, and that a second identical fix
  does *not* re-fire `reached_waypoint`. This also turned it into a better
  test, since it now actually exercises the "fires once" guarantee instead
  of accidentally contradicting it.
- **How it was caught:** Manual hand-trace of the test against
  `OfflineNavigator`'s logic — the sandbox's shell was unavailable all of
  V1, so `npm test` itself has still never actually been run against this
  repo. Running it for real is the single highest-value next step and may
  surface bugs this kind of review can't catch (e.g. TypeScript compile
  errors, workspace dependency resolution issues).
