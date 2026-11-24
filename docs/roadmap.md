# OffGrid Roadmap

## Done (V1)

- Shared type contract between backend and mobile (`packages/shared`).
- Backend: trail search, trail detail, trip package building
  (official/promoted landmark photos only), contribution intake.
- Mobile core logic: `TripPlannerClient`, `PackageStore`, `OfflineNavigator`
  (on/off-route + waypoint proximity detection), `LandmarkMatcher`
  (cosine-similarity photo matching against downloaded reference photos),
  `SyncQueue` (offline-first contribution queue, flushes on reconnect).
- Adapter interfaces (`StorageAdapter`, `NetworkAdapter`, `GpsAdapter`,
  `CameraAdapter`, `EmbeddingAdapter`, `MapAdapter`) isolating every
  native/ML/device dependency behind a seam that's fully testable without a
  device.
- Use-case-level integration tests for all of the above (backend + mobile).

## Done (V2)

- **Crowdsourced promotion pipeline** (closes item 4 below, partially).
  `landmarkPhotoService.ts` is now the canonical mutable photo store (seeded
  from fixtures, grown by promotions) that `packageService` reads from.
  `contributionService.ts` auto-promotes a contributed photo once 2+
  distinct contributors corroborate the same waypoint within a 50m/180-day
  tolerance, and exposes `manuallyPromote()`/`manuallyReject()` plus
  `POST /contributions/:id/promote` and `/:id/reject` for human review —
  the hybrid model flagged as an open question during planning. Still open:
  the abuse/quality defenses (duplicate/blur detection, reputation) item 8
  already called out — the corroboration rule as built trusts
  `waypointHintId` as-is and has no spam protection.
- **Trail version/update-check flow** (closes item 6 below). `trailService`
  now holds a mutable, resettable trail store with `getTrailVersion()` and
  `bumpTrailVersion()`; `GET /trails/:id/version` is a lightweight staleness
  check. Mobile's new `UpdateChecker` compares a downloaded package's
  `trailVersion` against the backend's current version — meant to run
  opportunistically (app launch, pull-to-refresh), not mid-hike.
- **Hazard/wash-out reporting MVP** (partially closes item 7 below).
  `hazardService.ts` mirrors the photo-contribution shape: hazard reports
  queue as `pending_review` and get `verified` either by 2+ independent
  corroborating reports, or immediately if severity is `'impassable'`
  (asymmetric-risk call — see the comment in `hazardService.ts` for why,
  and why that path is also the easiest to abuse). Mobile's
  `HazardReportQueue` reuses a newly-extracted generic `OfflineUploadQueue`
  engine that `SyncQueue` now also builds on, so both contribution types
  share one offline-queue implementation. **Not done:** there's no manual
  promote/reject endpoint for hazards yet (contributions got one, hazards
  didn't — a natural next addition), and this is still not the
  image-based "trail condition" classification originally envisioned for
  this item, just a structured-report version of it.

## Next up (not yet built — in rough priority order)

1. **Real native mobile shell.** Wire actual React Native screens, and
   implement the adapter interfaces for real: MapLibre GL Native
   (`MapAdapter`), react-native-geolocation (`GpsAdapter`),
   react-native-vision-camera (`CameraAdapter`), a local persistence layer
   (`StorageAdapter`), and fetch + NetInfo (`NetworkAdapter`). This is the
   step that turns the tested core logic into an app someone can actually
   open on a phone.

2. **Real on-device VPR model.** Replace the built-in image fingerprint
   (`mobile/src/core/imageFingerprint.ts`, behind `EmbeddingAdapter`) with a
   ready-made, pretrained model exported to TFLite/Core ML/ONNX (team
   decision: no custom training). The phone only *runs* the model to compare
   photos; it never trains it (see "How learning works" in `ROADMAP.md`).
   Needs a custom app build (not Expo Go).

3. **Real trail/map data ingestion.** Replace the fixture trail with an
   actual pipeline pulling OpenStreetMap (via Overpass) for international
   coverage and USGS/USFS/NPS data for US trails and elevation detail, plus
   generating real offline vector tile bundles (MBTiles/PMTiles) instead of
   the current placeholder `mapTiles.uri` reference.

4. **Harden the promotion pipeline.** Built in V2 (see above), but still
   needs: abuse/quality defenses (duplicate detection, blur detection,
   GPS-consistency checks against the trail path) before anything reaches a
   reviewer or an auto-promotion rule; re-validating `waypointHintId`
   against `location` instead of trusting it outright; a manual
   promote/reject pair for hazard reports matching the one contributions
   already has; and a real decision on whether 2 corroborators is the right
   threshold (picked as a reasonable-sounding default, not from any data).

5. **Server-side embedding refinement.** Once real contributions exist, use a
   heavier model (EigenPlaces/CosPlace-class, or AnyLoc/SALAD if compute
   allows) to build more robust canonical embeddings per waypoint out of
   multiple contributed angles/seasons/lighting conditions, improving
   matching accuracy over time as described in the original design
   discussion. Also needed just to make promoted contributed photos
   matchable at all (see item 2).

6. **Trail version/update flow polish.** The check exists now (V2), but
   nothing surfaces it in a UI, there's no actual re-download-just-the-diff
   optimization (a version bump currently means re-downloading the whole
   package), and `bumpTrailVersion()` is a test/demo stand-in for whatever a
   real content pipeline would trigger this from.

7. **Hazard/wash-out layer, full version.** V2 added structured
   report-and-verify (see above). Still missing: image-based trail-condition
   assessment (the originally-envisioned "is this washed out" from a photo,
   likely a different, more general-purpose model than the closed-set VPR
   approach used for landmark matching), severity escalation/expiry of old
   hazards, and surfacing hazards on the offline map/navigation UI once that
   exists.

8. **Privacy/moderation for contributed content.** Contributed photos may
   contain other people's faces or reveal sensitive locations (fragile
   sites, rare species); contributed hazard reports have the same
   single-report-can-trigger-action risk flagged in `hazardService.ts`.
   Needs a policy decision and likely automated face-blurring plus a report
   mechanism before the promotion pipeline is trusted with real traffic.

9. **Safety-adjacent features (not committed to yet, flagged during
   planning):** last-known-position breadcrumb trail for backtracking when
   GPS is lost entirely, offline emergency info. Worth revisiting once the
   core loop is proven out.

## Done (security hardening, 2026-11-18)

- Real image sanitization (decode, bomb guard, metadata strip, re-encode), plus
  input validation and abuse limits across backend and mobile. See
  `docs/SECURITY.md` and BUG-004 to BUG-016 in `docs/BUGS.md`.
- Partially addresses item 4: `waypointHintId` is now checked against the
  trail and against the upload's own location.
- Partially addresses item 8: EXIF/GPS metadata is stripped from every
  contributed photo. Face blurring and moderation are still open.

## Done (Waze-style hazard verification, 2026-11-19)

- Hazard reports merge into incidents with a confidence score built from
  "still there"/"not there" votes, weighted by GPS proximity, reporter trust
  and time decay (per hazard type). Incidents ship only while confident
  enough, and ship with `expiresAt` so phones drop stale warnings offline.
  Severity-based thresholds replace the old "impassable = instantly
  verified" rule: impassable still ships after one report, but labelled
  unconfirmed, and one "not there" takes it down.
- Offline "Still there?" loop on mobile (`approaching_hazard` event plus
  `HazardVoteQueue`).
- Closes the hazard half of item 4's "manual promote/reject parity" gap:
  reviewer verify/resolve/reject endpoints for hazards.
- Details: `docs/HAZARD_VERIFICATION.md`. Still open from item 7:
  image-based condition detection, and showing hazards on the map UI.

## Also needed before real users

10. **Real authentication.** User accounts for contributors, and a
    reviewer role instead of the shared `OFFGRID_REVIEWER_TOKEN`. See the
    "Known gaps" list in `docs/SECURITY.md`.
11. **Persistence.** A database and object storage for photos instead of
    in-memory maps, and shared state for rate limiting/idempotency if more
    than one server instance runs.

## Verification

`npm run check` runs typecheck and every test, locally and in CI. Hand
review still catches things tests don't, so log anything found in
`docs/BUGS.md`.
