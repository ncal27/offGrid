# OffGrid Architecture (V1 + V2)

## What OffGrid is

Plan a hike while you have signal, download everything you need onto the
phone, then navigate fully offline — no wifi, no cell. Phone GPS chips work
without a network connection (they just need sky view), so "offline" really
means "no live map tiles, no live weather, nothing downloadable mid-hike," not
"no location at all." The one gap GPS alone doesn't cover is confirmation
when a fix is weak or absent (dense canopy, canyons) — OffGrid closes that
gap with a photo-based landmark confirmation feature.

## V1 scope

In scope: plan a trip online, download a self-contained "trip package,"
navigate the route offline using GPS, and confirm position/trail-correctness
by matching a photo against the package's downloaded reference landmark
photos.

Deliberately out of scope for V1, tracked in `docs/roadmap.md`: hazard and
wash-out detection, automated promotion of crowdsourced photos into the
official dataset, a real trained on-device vision model (V1 uses a pluggable
interface with a stub/fake implementation — see below), and actual native
mobile screens (map rendering, camera capture UI).

## V2 additions

V2 kept V1's scope boundary (still no native shell, still no real on-device
model) and instead built out the data lifecycle around the core loop:

- A **crowdsourced photo promotion pipeline** — `contributionService.ts`
  auto-promotes a contributed landmark photo once independent hikers
  corroborate the same waypoint, with a manual-review override alongside it.
- A **trail version/update-check flow** — `trailService.getTrailVersion()` +
  `GET /trails/:id/version`, with mobile's `UpdateChecker` comparing it
  against what's already downloaded.
- A **hazard/wash-out reporting MVP** — `hazardService.ts`, since replaced
  by a Waze-style confidence model (reports merge into incidents; "still
  there"/"not there" votes weighted by proximity, trust and time decay; ship
  only while confident). See `docs/HAZARD_VERIFICATION.md`.

See `docs/roadmap.md`'s "Done (V2)" section for exactly what each of these
does and doesn't yet handle, `docs/BUGS.md` for bugs found and fixed, and
`docs/SECURITY.md` for how untrusted input and images are handled.

## Repo layout

```
offgrid/
  packages/shared/   # TypeScript types shared by backend and mobile — the contract between them
  backend/           # Express API: trail search, trip package building, contribution intake
  mobile/            # Platform-agnostic core logic + adapter interfaces for native/ML integration
  docs/              # This file and the roadmap
```

## Data flow

1. **Plan (online).** `TripPlannerClient` (mobile) calls the backend to
   search trails and fetch full trail detail.
2. **Download (online).** `TripPlannerClient.fetchTripPackage()` asks the
   backend to build a `TripPackage`: the trail's route line, waypoints,
   elevation profile, a reference to an offline vector tile bundle, and the
   trail's official landmark photos (with precomputed embeddings). Only
   photos with `status: 'official'` or `'promoted'` are ever included — see
   "Data sourcing strategy" below.
3. **Store.** `PackageStore` persists the `TripPackage` via an injected
   `StorageAdapter`. This local copy *is* the on-device database everything
   else runs against.
4. **Navigate (offline).** `OfflineNavigator` takes GPS fixes (via
   `GpsAdapter`) and compares them against the stored route line and
   waypoints — entirely locally, no network calls anywhere in this path. It
   emits `on_route` / `off_route` / `approaching_waypoint` / `reached_waypoint`
   events that a UI layer (not built yet) would render on the map.
5. **Confirm with a photo (offline).** `LandmarkMatcher` takes a captured
   photo (via `CameraAdapter`), runs it through an on-device embedding model
   (via `EmbeddingAdapter`), and compares the resulting vector against the
   package's downloaded reference photo embeddings using cosine similarity.
   Because each trail only ships a handful of reference photos — not a
   city- or planet-scale database — this is a much easier search problem than
   general visual place recognition (VPR), so even a lightweight embedding
   model is sufficient.
6. **Contribute (offline, synced later).** A hiker can tag an additional
   landmark photo in the field. `SyncQueue` stores it locally via
   `StorageAdapter` and only uploads it once `NetworkAdapter.isOnline()`
   reports connectivity again (e.g. back at the trailhead).

## The adapter pattern, and why

This sandbox has no iOS/Android simulator, so there's no way to exercise real
map rendering, camera hardware, GPS hardware, or an on-device ML runtime
here. Rather than write code that can't be run or verified, all of
OffGrid's actual decision-making logic (`OfflineNavigator`, `LandmarkMatcher`,
`PackageStore`, `SyncQueue`, `TripPlannerClient`) is pure TypeScript that
depends only on small interfaces defined in `mobile/src/core/adapters/`:

- `StorageAdapter` — local persistence (real: MMKV/SQLite/react-native-fs)
- `NetworkAdapter` — HTTP + connectivity check (real: fetch + NetInfo)
- `GpsAdapter` — device location (real: react-native-geolocation)
- `CameraAdapter` — photo capture (real: react-native-vision-camera)
- `EmbeddingAdapter` — the on-device VPR model (see below)
- `MapAdapter` — offline map rendering (real: MapLibre GL Native)

Tests use fakes for all of these (`mobile/src/testUtils/mockAdapters.ts`),
so the full plan → download → navigate → photo-confirm → contribute → sync
loop is verified without a device. Wiring real native modules behind these
same interfaces is the next concrete step once this moves to an environment
that can run React Native.

`SyncQueue` (photo contributions) and `HazardReportQueue` (hazard reports)
are both thin subclasses of a generic `OfflineUploadQueue<TUpload, TAck>`
(added in V2) that holds the actual enqueue/pending/flush-on-reconnect
logic — added once a second "queue something offline, send it when
reconnected" use case (hazards) showed up, rather than speculatively built
in V1 for a use case that didn't exist yet.

## Model strategy: specialized, not general-purpose

The photo-matching feature is deliberately built on **visual place
recognition (VPR)**, a research area purpose-built for "does this photo match
a known location," rather than a general multimodal model (GPT-4V/Gemini/
Claude-vision style) trying to understand everything about an image.
Relevant reference points from current research:

- **CosPlace** and **EigenPlaces** — established baselines that frame place
  recognition as classification over geographic cells.
- **HOGNet** and **MSGC-NetVLAD** (2026) — efficiency-focused variants aimed
  at exactly the profile OffGrid needs: HOGNet reportedly matches
  CosPlace/EigenPlaces-level accuracy while running ~36x faster and using 59%
  fewer parameters than a VGG16-based model. This is the realistic target for
  the **on-device** model behind `EmbeddingAdapter`.
- **AnyLoc / SALAD** (ViT/DINOv2-based) — more state-of-the-art but too heavy
  for on-device use; a better fit for **server-side** processing of
  aggregated crowdsourced photos (building richer canonical embeddings per
  waypoint from multiple contributed angles/seasons/lighting).

`EmbeddingAdapter.embed()` is intentionally a narrow interface (photo in,
vector out) so swapping in a real exported TFLite/Core ML/ONNX model later
doesn't require touching `LandmarkMatcher`'s matching logic at all.

## Data sourcing strategy

- **International backbone:** OpenStreetMap, pulled via the Overpass API —
  free, global, has reasonable hiking-trail tagging (`route=hiking`
  relations) nearly everywhere.
- **US domestic:** layered on top from USGS / USFS / NPS-style government GIS
  data, which tends to be more authoritative for official trails and
  elevation contours than OSM alone.
- **Elevation:** SRTM for global coverage, USGS 3DEP for better US
  resolution.
- **Landmark photos:** official/curated at launch (`PhotoStatus: 'official'`
  in `packages/shared/src/types.ts`), with hiker contributions accepted as
  `'pending_review'` and promoted into `'promoted'` either automatically
  (corroboration) or by a human reviewer — see `contributionService.ts` and
  `docs/roadmap.md` item 4 for what's still unhardened about that pipeline.
- **Hazard reports:** same shape as landmark photos (`hazardService.ts`),
  with an added urgency path for severe reports — see `docs/roadmap.md`
  items 7–8.

None of the external map/trail data sources above are actually integrated
yet; the backend currently serves one fixture trail
(`backend/src/data/fixtures.ts`) standing in for a real ingestion pipeline,
so the rest of the system (packaging, offline navigation, photo matching,
contribution/hazard sync, promotion, versioning) could be built and tested
against something concrete.

## A note on verification

V1 and V2 were built in a sandbox with no shell and verified by hand. On
2026-11-18 the suite was run for the first time: install and typecheck were
clean and 54/55 tests passed (the failure was BUG-004). A security review
then found and fixed BUG-005 to BUG-016. `npm run check` (typecheck + all
tests) now runs locally and in CI on every push.
