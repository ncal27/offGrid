# OffGrid Bug Log

A running record of bugs found and how they were fixed, kept separate from
`docs/roadmap.md` (which tracks *unbuilt* features, not defects in what
exists). Add an entry here any time a bug is found, whether by running the
test suite or by code review. BUG-001 to BUG-003 were found by hand-review
before the suite had ever run; from BUG-004 on, every bug was reproduced by
an actual failing request or test before it was fixed.

## Review log

| Date | Scope | Outcome |
| --- | --- | --- |
| 2026-11-16 | V1: shared types, backend (trail search/package/contributions), mobile core (navigator, matcher, sync queue) + their integration tests | Found and fixed BUG-001 |
| 2026-11-18 | V2: landmarkPhotoService + trailService refactor to mutable stores, contribution promotion pipeline, trail version/update-check flow, hazard reporting MVP, OfflineUploadQueue extraction, and all new integration tests | No new bugs found; traced type-narrowing, Express route ordering, module-isolation-per-test-file assumptions, and the promotion/corroboration math by hand |
| 2026-11-18 (later) | Input validation/sanitization layer: shared validators, backend image validation, request validation wired into contribution/hazard routes, volume caps, JSON error handling, mobile pre-validation | Found and fixed BUG-002 and BUG-003 while writing tests for the new validation, before ever running them |
| 2026-11-18 (first real run) | First ever `npm install` / `npm test` / `tsc`, then a security review of every trust boundary (backend routes, image handling, mobile queue/client/storage) | Install and typecheck clean; 54/55 tests passed. The failure was BUG-004. Review found BUG-005 to BUG-016, each reproduced with a request or test against the original code before fixing. Real image sanitization (decode + re-encode with sharp) added; see `docs/SECURITY.md` |

## Open

_None currently._

## Fixed

### BUG-004 — any large photo upload crashed the endpoint with a 500 (regex stack overflow)

- **Severity:** High (legitimate users affected; easy denial of service).
- **Where:** base64 check in `backend/src/validation/imageValidation.ts` and `packages/shared/src/validation.ts`.
- **What happened:** The base64 regex `^(?:[A-Za-z0-9+/]{4})*...$` makes V8's regex engine recurse once per 4 characters. Around ~9M characters (a normal ~7MB phone photo) it throws `RangeError: Maximum call stack size exceeded`, so the route crashed and returned 500. This was the one failing test on the first real `npm test` run ("rejects a decoded image larger than the 8MB cap" got 500, not 400). On a phone running React Native the shared copy of the regex would have done the same.
- **Fix:** Replaced the regex with `isStrictBase64()`, a linear loop with constant stack, used by both backend and mobile.
- **How it was caught:** Running the test suite for the first time.

### BUG-005 — contributions/hazards for non-existent trails were accepted and stored

- **Severity:** Medium (unbounded memory growth).
- **Where:** `backend/src/routes/contributions.ts`, `backend/src/routes/hazards.ts`.
- **What happened:** Any well-formed `trailId` was accepted, even one that doesn't exist. The per-trail cap (500 pending) is per trail, so making up a new trailId for each request bypassed it completely, and the pending maps (holding up to 8MB images each) grew without limit.
- **Fix:** Routes return `404 trail_not_found` for unknown trails. Added a global byte budget on pending images (`503 contribution_storage_full`) and a per-IP rate limit, because contributor IDs are self-asserted and per-contributor caps alone are easy to dodge.

### BUG-006 — fake or contradictory `waypointHintId`s were trusted and could be auto-promoted

- **Severity:** Medium (bad data ships to every hiker).
- **Where:** `resolveWaypointId()` in both services (now `backend/src/services/waypointResolution.ts`); manual promote override.
- **What happened:** Two contributors sending `waypointHintId: "fake-wp"` got a photo **promoted** and shipped in every trip package, attached to a waypoint that doesn't exist. A hint was also trusted even when the GPS location sent with it was kilometres away. The reviewer's `waypointId` override wasn't checked against the trail either.
- **Fix:** Routes reject hints that aren't waypoints on that trail (400). Resolution ignores a hint that the upload's own location contradicts (beyond 50m). Manual promote rejects waypoints on other trails. One duplicated helper was consolidated into a shared module.

### BUG-007 — a client could overwrite someone else's submission, and retries created duplicates

- **Severity:** Medium.
- **Where:** `submitContribution()` / `submitHazardReport()`.
- **What happened:** Client-supplied `id`s went straight into `Map.set(id, ...)`. (a) Anyone who knew or guessed an id could replace another hiker's pending contribution with their own (different contributor, different image). (b) The mobile offline queue resends an item whenever a response is lost, and a resent `impassable` hazard was verified **again**, so duplicate hazards shipped in every package.
- **Fix:** Every accepted id is remembered with its owner. Same id + same owner is an idempotent retry (`200` with the original ack, nothing stored). Same id + different owner returns `409 submission_id_conflict`.

### BUG-008 — any RIFF file (WAV, AVI) passed as a WebP image

- **Severity:** Low/Medium.
- **Where:** `backend/src/validation/imageValidation.ts`.
- **What happened:** The WebP signature check only looked for `RIFF` at offset 0, which every WAV/AVI file also has. More generally, a magic-byte check only proves the first few bytes look right.
- **Fix:** WebP now also requires `WEBP` at offset 8. More importantly, every image is now fully decoded and re-encoded (see `docs/SECURITY.md`), so files that merely *start* like an image are rejected.

### BUG-009 — the review endpoints (promote/reject) had no authentication

- **Severity:** High.
- **Where:** `POST /contributions/:id/promote`, `/:id/reject`.
- **What happened:** Anyone could promote any pending photo straight into the official dataset (which ships to every hiker) or delete other people's contributions. The code comment said "not safe to expose publicly", but nothing stopped it.
- **Fix:** `backend/src/middleware/requireReviewer.ts` requires `Authorization: Bearer $OFFGRID_REVIEWER_TOKEN`, compared in constant time. If the token is unset or under 32 characters, the endpoints are **disabled** (503); they fail closed. This is a stopgap until real user accounts and roles exist (roadmap).

### BUG-010 — every route accepted 15MB request bodies

- **Severity:** Low (resource exhaustion).
- **Where:** `backend/src/app.ts`.
- **What happened:** BUG-002's fix raised the global JSON limit to 15MB, so `/hazards/reports` and every other route would parse 15MB bodies too.
- **Fix:** 15MB only for `/contributions/photos`; 100kb for everything else.

### BUG-011 — one rejected upload blocked a phone's entire offline queue, forever

- **Severity:** High (silent data loss for hikers; safety reports never sent).
- **Where:** `mobile/src/core/OfflineUploadQueue.ts`.
- **What happened:** `flush()` didn't catch errors. If the backend rejected one queued item (e.g. a 400 from the stricter validation above), flush threw, and because items are flushed in the same order every time, every hazard report and photo queued after it was never sent again. Reproduced: three flushes, the good report never sent.
- **Fix:** Permanent rejections (4xx other than 408/429) move to a separate "rejected" list the UI can show, and flushing continues. Transient failures (dropped connection, 5xx, 429) keep the item queued for the next flush. Added `HttpError` to the `NetworkAdapter` contract so real adapters can signal which is which.

### BUG-012 — unvalidated IDs in mobile URLs and storage paths

- **Severity:** Medium.
- **Where:** `mobile/src/core/TripPlannerClient.ts`, `PackageStore.ts`, `OfflineUploadQueue.ts`.
- **What happened:** `getTrail("../contributions/x/promote")` requested `/trails/../contributions/x/promote`, a different endpoint. `PackageStore.save()` with trailId `../../secrets/evil` wrote the key `trip-packages/../../secrets/evil.json`, which is path traversal once a real filesystem adapter is plugged in.
- **Fix:** IDs are validated with `isSafeId` and URL-encoded. `fetchTripPackage` also checks that the server returned the trail it asked for.

### BUG-013 — NaN embeddings produced `NaN` match confidence

- **Severity:** Low.
- **Where:** `mobile/src/core/LandmarkMatcher.ts`.
- **What happened:** A NaN or Infinity in a model output or a corrupted package made every similarity `NaN`, which breaks sorting and threshold logic and shows up as `confidence: null` in JSON.
- **Fix:** Non-finite values score 0 (no match).

### BUG-014 — hazard reports with no location "corroborated" each other

- **Severity:** Medium (false hazards verified and shipped).
- **Where:** `findCorroborators()` in `backend/src/services/hazardService.ts`.
- **What happened:** When neither report had a location or a hint, both resolved to waypoint `undefined`, and `undefined === undefined`. So any two reports of the same type anywhere on the trail were treated as confirming each other and got **verified**.
- **Fix:** Corroboration requires both reports to resolve to the same known waypoint.

### BUG-015 — free text allowed invisible and direction-changing characters, and blank descriptions

- **Severity:** Low/Medium.
- **Where:** `isSafeText()` in `packages/shared/src/validation.ts`.
- **What happened:** A description like `"safe \u202Eelbassapmi"` displays as "safe impassable" (the "Trojan Source" bidi trick), so a reviewer could see something different from what's stored. Zero-width characters were also allowed, and so was a description of only spaces.
- **Fix:** Rejects C1 controls, zero-width characters, bidi overrides/isolates, Unicode line separators, BOM, and whitespace-only text. Normal accented text, emoji and newlines still work (tested).

### BUG-016 — error handler mislabelled internal errors; async route errors would have been lost

- **Severity:** Low.
- **Where:** `backend/src/app.ts`, `backend/src/routes/contributions.ts`.
- **What happened:** `err instanceof SyntaxError` matched SyntaxErrors from our own code and told the client their JSON was invalid. Separately, once the photo route became async (for image decoding), Express 4 would not have caught its errors at all.
- **Fix:** Classifies only by body-parser's `err.type`, logs unexpected errors server-side, and wraps the async route so its errors reach the handler. Unknown routes now return JSON 404s.

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
