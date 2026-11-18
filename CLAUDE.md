# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OffGrid: plan a hike online, download a self-contained "trip package," then
navigate fully offline (GPS works without wifi/cell) with a photo-based
landmark-matching feature to confirm position when GPS is weak or absent.
Read `docs/architecture.md` and `docs/roadmap.md` before making non-trivial
changes — they explain the data flow, the adapter pattern the mobile core is
built around, the visual-place-recognition model strategy, and exactly what
is and isn't built yet.

This repo was built in a sandbox with no shell/npm access and no
iOS/Android simulator, so **`npm install` has never been run against it and
the test suites have never actually been executed.** Treat that as the first
task in any new session, not an assumption to skip.

## Commands

```bash
npm install                 # install all workspaces (run this first, in a real shell)
npm test                    # run backend + mobile test suites
npm run test:backend        # backend only
npm run test:mobile         # mobile only
npm run dev:backend         # start the Express API on :4000
```

Run a single test file directly with Jest from inside the relevant workspace, e.g.:

```bash
cd backend && npx jest test/integration/tripDownload.test.ts
cd backend && npx jest test/integration/promotionPipeline.test.ts
cd backend && npx jest test/integration/hazardReporting.test.ts
cd mobile && npx jest test/integration/photoLandmarkConfirmation.test.ts
cd mobile && npx jest test/integration/updateCheck.test.ts
```

There is no lint config and no build/typecheck script wired into `npm test`
yet; `tsc --noEmit` is available per-workspace (`npm run typecheck` in
`backend` or `mobile`) but has not been run, so expect to find and fix type
errors on first use.

## Architecture

This is an npm-workspaces monorepo: `packages/shared` (types), `backend`
(Express API), `mobile` (platform-agnostic core logic only — no React Native
app has been scaffolded yet).

**`packages/shared/src/types.ts`** is the single contract between backend and
mobile — `Trail`, `TripPackage`, `LandmarkPhoto`, `GpsFix`, `NavigationEvent`,
`PhotoMatchResult`, `ContributedPhotoUpload`, etc. Both workspaces import
these directly from TypeScript source (no build step for `@offgrid/shared`),
which is why both `backend/jest.config.js` and `mobile/jest.config.js` set
`transformIgnorePatterns: ['/node_modules/(?!@offgrid)']` — without that,
Jest would try to run `@offgrid/shared`'s `.ts` files as if they were
pre-compiled JS and fail.

**Backend** (`backend/src`) currently serves one fixture trail
(`data/fixtures.ts`, "Shadow Creek Loop") standing in for a real
OpenStreetMap/USGS/USFS/NPS ingestion pipeline — there is no database, no
auth, and no persistence beyond in-memory `Map`/`Map`-backed stores in
`services/contributionService.ts`, `services/hazardService.ts`,
`services/landmarkPhotoService.ts`, and `services/trailService.ts` (hence
the `_resetForTests()` test-only export on each). The important design
invariant, covered by `test/integration/tripDownload.test.ts` and
`test/integration/promotionPipeline.test.ts`, is that `buildTripPackage()`
only ever includes `LandmarkPhoto`s with `status: 'official'` or
`'promoted'` (and `HazardReport`s with `status: 'verified'`) — a freshly
contributed photo or hazard report must never appear in a downloadable
package until promoted/verified.

`contributionService.ts` and `hazardService.ts` both now implement a
corroboration-based promotion/verification rule (2+ distinct
contributors/reporters near the same waypoint within a tolerance window —
see each file's top comment for the exact numbers and the trust
assumptions they rest on, especially that `waypointHintId` is trusted
as-is). `contributionService.ts` additionally exposes a human-review
override (`manuallyPromote`/`manuallyReject`, routed at
`POST /contributions/:id/promote` and `/:id/reject`) — `hazardService.ts`
does not have an equivalent yet, which is a known gap (roadmap item 4).
Read `docs/roadmap.md`'s "Done (V2)" section before changing either of
these — several deliberately-simple choices (the `2` threshold, the
distance/time tolerances, trusting `waypointHintId`) are flagged there as
needing real data/decisions, not as settled design.

`trailService.ts` holds a mutable, resettable copy of the fixture trails
(not the fixtures directly) specifically so `bumpTrailVersion()` can
simulate an official-data update for `GET /trails/:id/version` /
`UpdateChecker` without polluting fixture state across test files.

**Mobile core** (`mobile/src/core`) is pure TypeScript with zero React
Native/device dependencies, built this way specifically because this sandbox
can't run a simulator — every native/ML concern is pushed behind a small
adapter interface in `mobile/src/core/adapters/` (`StorageAdapter`,
`NetworkAdapter`, `GpsAdapter`, `CameraAdapter`, `EmbeddingAdapter`,
`MapAdapter`), each documented with what real library should eventually
implement it. The actual logic worth understanding:

- `OfflineNavigator` — compares `GpsFix`es against a `Trail`'s route line
  (point-to-polyline distance in `geo.ts`) and waypoints, entirely offline,
  emitting `on_route`/`off_route`/`approaching_waypoint`/`reached_waypoint`.
- `LandmarkMatcher` — cosine-similarity match of a captured photo's embedding
  (via `EmbeddingAdapter`, currently always a fake in tests) against a
  trail's downloaded reference photo embeddings. Deliberately a closed-set,
  per-trail search rather than general visual place recognition — see
  `docs/architecture.md` for why that changes which models are viable
  on-device.
- `SyncQueue` / `HazardReportQueue` — queue `ContributedPhotoUpload`s /
  `HazardReportUpload`s locally and only flush to the backend when
  `NetworkAdapter.isOnline()` is true; synced items are removed from the
  local queue. Both are thin subclasses of the generic
  `OfflineUploadQueue<TUpload, TAck>` — extend that one, not either
  subclass, if a third offline-queued upload type shows up.
- `UpdateChecker` — compares a downloaded `TripPackage.trailVersion` against
  `TripPlannerClient.checkTrailVersion()`'s live result; a trail with
  nothing downloaded yet is reported as "not stale" (there's nothing to be
  stale relative to), not as needing an update.

`mobile/src/testUtils/` holds reusable fakes (`InMemoryStorageAdapter`,
`FakeNetworkAdapter`, `ScriptedGpsAdapter`, `FakeEmbeddingAdapter`) and a
fixture trail mirroring the backend's, kept independently so mobile tests
don't depend on the backend package.

Both `backend/test/integration/*` and `mobile/test/integration/*` are named
and written around real user scenarios (plan+download, navigate offline,
photo confirmation, contribute+sync) rather than one-test-per-function —
keep that framing when adding tests for new behavior instead of reverting to
unit-testing individual methods in isolation.

## Bugs

`docs/BUGS.md` is a living log, separate from the roadmap (which tracks
unbuilt features, not defects). Check it before assuming something is
correct, and add to it — don't just silently fix — whenever you find a real
bug, the same way BUG-001 was logged during V1.

## What's not built yet

See `docs/roadmap.md` for the full list and priority order — it has "Done
(V1)" and "Done (V2)" sections describing exactly what exists, plus what's
explicitly still open within each V2 feature (e.g. promotion pipeline abuse
defenses, hazard manual-review parity with contributions). The short
version: no real React Native app/screens, no real on-device VPR model (the
embedding step is entirely faked in tests, and now also blocks promoted
contributed photos from being matchable), no real map tile generation, and
no image-based hazard/trail-condition detection (V2 added structured
report-and-verify, not image classification).
