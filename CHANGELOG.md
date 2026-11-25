# Changelog

Every change to this project goes here, whoever or whatever made it: a
teammate, Claude, Copilot, ChatGPT, Cursor, or anything else. Format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (see "Versioning" in
`CONTRIBUTING.md`).

## How to add an entry

Add a bullet under **[Unreleased]**, in the right group (Added / Changed /
Fixed / Removed / Security), in this shape:

```
- <What changed and why, in one or two lines>. (<who>, <tool used or "by hand">, <YYYY-MM-DD>)
```

Example:

```
- Lowered the downed-tree share threshold to 1.25 after field testing showed too few confirmations. (Sam, Claude Code, 2026-12-02)
```

Not sure what you changed? Run `npm run changes` to list every file that
differs from the last release.

## [Unreleased]

### Added
- "Hiking places near <town>" in the planner conversation: lists named trails within 5 miles (or "within N miles", max 15) with length, estimated time, estimated difficulty and distance from town; sort by closest, longest, shortest, easiest, hardest or quickest (buttons or voice); pick by number, "the second one" or name to plan it. "Near me" asks for a town (no GPS yet). New `POST /trails/nearby` (geocode + OpenStreetMap radius search, validated and rate limited). Core rules in `mobile/src/core/trailDiscovery.ts`; tests for both. (Team, Claude Code, 2026-11-25)
- "Plan a trip" asks follow-up questions instead of failing: which trail or park (if none was named), what town and state (if it isn't found near Wellesley), then another name or the park it's in; gives up politely after 3 questions and keeps what was said about "when". Rules in `mobile/src/core/tripPlannerDialog.ts` with tests. (Team, Claude Code, 2026-11-25)
- `POST /trails/import` accepts `near` ("Canton, MA"): the town is looked up with OpenStreetMap's Nominatim geocoder and the trail search runs around it (area capped at 0.6° so a whole state can't be searched). Place text is validated and geocoder results checked; tested with stand-in services. (Team, Claude Code, 2026-11-25)
- "Plan a trip" by voice or text: e.g. "I'm hiking Blue Hills this Saturday, plan a trip for me". The app finds the trail (or fetches it from OpenStreetMap), downloads it with its photos, switches the photo filter to that date's season, and answers out loud (expo-speech). Browser mic via built-in speech recognition; on phones, the keyboard's dictation. Parser in `mobile/src/core/tripRequest.ts` with tests. (Team, Claude Code, 2026-11-24)
- "Keep OffGrid open" warning once a trail is downloaded or you're offline (closing the app erases downloads and unsent changes), and a leave-page prompt in browsers. (Team, Claude Code, 2026-11-24)
- "Go offline" button at the top: every network request the app attempts while offline is blocked and counted, with an on-screen "Internet requests blocked: N · sent: 0" as proof for the demo. (Team, Claude Code, 2026-11-24)
- Reference photos are saved on the device when a trail is downloaded, so the photo gallery and viewer work offline. (Team, Claude Code, 2026-11-24)
- "Where am I?": take or choose a photo and the app compares it with the saved reference photos, fully offline, giving a best-guess place and a confidence; low confidence asks for another photo; several photos are combined. Uses a built-in image fingerprint (colour, layout, edges), a stand-in for a trained model. Leave-one-out on the real Blue Hills photos: 10 of 11 placed correctly. (Team, Claude Code, 2026-11-24)
- Photo sharing loop: high-confidence (or confirmed) "Where am I?" photos can be shared as reference photos, queued offline and uploaded on reconnect; low-confidence photos stay on the phone. Promoted hiker photos are now served by the API (`GET /photos/:id.jpg`) and ship in trip packages as new references. (Team, Claude Code, 2026-11-24)
- Blue Hills (Great Blue Hill & Skyline Trail), a real trail network with 16 side trails and 7 places (Trailside Museum trailhead, summit, Eliot Tower, Little Blue/Wolcott/Hemenway Hills, Breakneck Ledge), built from OpenStreetMap by `npm run data:blue-hills`. (Team, Claude Code, 2026-11-24)
- Seasonal reference photos: 12 free-licensed Wikimedia Commons photos tied to places, with season from the capture date and the photographer/licence/link kept and shown. Only free licences and Wikimedia's own image hosts are accepted. (Team, Claude Code, 2026-11-24)
- Interactive map: zoom (+/−/Fit), drag to pan, tap a place to zoom in and see its photos, side trails drawn dashed and tappable for hazards. Photo gallery filters by season (current season marked) and place; tap a photo for full size with credit. (Team, Claude Code, 2026-11-24)
- Trails can have side trails (`Trail.branches`); places have a `kind`; photos have `season`, `thumbnailUrl`, `title`, `attribution`. The offline navigator counts side trails as on-trail. (Team, Claude Code, 2026-11-24)
- Add trails live from OpenStreetMap: type a trail name in the app ("Add a trail"); the API (`POST /trails/import`) searches the Wellesley/MetroWest area, stitches the trail's pieces into one route and adds trailhead/midway/end waypoints. Search text is restricted and escaped before it reaches OpenStreetMap; OSM data is validated; imports are rate limited and capped at 50. (Team, Claude Code, 2026-11-24)
- Tap the trail map to drop a hazard anywhere on the trail (snaps to the nearest point on the route), with severity and type pickers. (Team, Claude Code, 2026-11-24)
- "Simulate no internet" switch: the app makes no network calls; downloaded trails still open; reports and "Not there" answers are saved on the device (dashed on the map) and sync when you switch back online. (Team, Claude Code, 2026-11-24)
- `npm run demo`: end-to-end walkthrough against the real API (plan, download, hazard tiers climbing with confirmations, photo upload, bad input refused). (Team, Claude Code, 2026-11-24)
- Expo app skeleton in `app/` (SDK 58): disclaimer, trail list, trip download, drawn route with hazards coloured by confidence tier, report hazard, "Not there", and a "Demo: simulate another hiker" button. Runs in Expo Go and in a browser. (Team, Claude Code, 2026-11-24)
- Backend CORS for the browser version of the app: explicit allow-list only (`OFFGRID_CORS_ORIGINS`, default `http://localhost:8081`), never a wildcard. Tested. (Team, Claude Code, 2026-11-24)
- `npm run preview`: serves the API and the web build of the app from one address (http://localhost:8080), so the app can be tried in a browser with no setup; stops after 30 minutes. Build with `npm run build:web` in `app/`. (Team, Claude Code, 2026-11-24)
- `HANDOFF.md`: how to run everything, and the next tasks in priority order. CI now also typechecks the app. (Team, Claude Code, 2026-11-24)

### Changed
- The planner no longer speaks its replies; it's a text conversation (🎤 Speak still works for input). Removed `expo-speech`. (Team, Claude Code, 2026-11-25)
- OpenStreetMap searches try the main Overpass server, then two public mirrors. (Team, Claude Code, 2026-11-25)
- Release tags are named `X.Y.Z` without a "v" (e.g. `1.0.0`), matching the published 1.0.0 release; docs updated. (Team, Claude Code, 2026-11-19)

### Fixed
- BUG-023: speaking again replaced the earlier part of the sentence; now it adds to it. BUG-024: the offline guard could double-wrap on a live reload; it now installs once and offline only changes via the button. BUG-025: every planner failure read "can't reach OpenStreetMap"; messages now say what actually failed and why. Regression tests for all three (Ironhide). (Team, Claude Code, 2026-11-25)
- BUG-022: `npm run build:web` could stop silently on Windows right after "Starting Metro Bundler". The app's bundler config no longer watches the repo-root `node_modules` or follows npm workspace links; the app has its own `jpeg-js`. Guard test added and CI now builds the web app. `npm run preview` explains what to do if the build produced nothing. (Team, Claude Code, 2026-11-25)
- BUG-021: Blue Hills "thumbnails" were full-size photos (Wikimedia returned 1280px, not the assumed 1024px). Data regenerated with 500px thumbnails; regression test added (Ironhide). (Team, Claude Code, 2026-11-24)
- BUG-020: a hazard's severity could be silently downgraded to "minor" when its reporter later said "not there". Regression test added (Ironhide). (Team, Claude Code, 2026-11-24)
- BUG-018: `npm run changes` no longer lists Expo build caches (`.expo`, `web-build`) as changes. BUG-019: cutting a release no longer leaves `VERSION` reported as changed. Both have regression tests in `scripts/changes.test.mjs`, now part of `npm run check` and CI. (Team, Claude Code, 2026-11-24)

### Removed

### Security
- App: patched `minimatch` (11.0.6) inside Expo's build tool `@expo/fingerprint` via an npm override, clearing the 3 moderate advisories (a build-time denial-of-service in file-pattern matching). `npm audit fix --force` would have downgraded Expo 58 → 52 instead. (Team, Claude Code, 2026-11-25)

## [1.0.0] - 2026-11-19

The baseline, cut from `main` on 2026-11-19 (including the hazard
confidence tiers). Everything after this is tracked against it
(`releases/v1.0.0.manifest.json`, git tag `1.0.0`).

### Added
- Core loop: plan a trail online, download a self-contained trip package, navigate offline by GPS, confirm position by photo, contribute photos and hazard reports offline, sync on reconnect.
- Crowdsourced photo promotion pipeline (2+ independent contributors, or a human reviewer).
- Trail version / update check.
- Waze-style hazard verification: reports merge into incidents with a confidence score built from "still there" / "not there" votes, weighted by GPS proximity, reporter trust and time decay; shown from the first report with a confidence tier. Offline "Still there?" prompts on mobile. See `docs/HAZARD_VERIFICATION.md`.
- Reviewer endpoints for contributions and hazards (token-protected).
- Image sanitization: every uploaded photo is decoded and re-encoded; metadata/GPS is stripped; decompression bombs, disguised files and animations are refused. See `docs/SECURITY.md`.
- Input validation for all IDs, text, coordinates and timestamps; per-IP rate limiting; security headers.
- CI (typecheck, tests, dependency audit), `npm run check`, change tracking (`npm run changes`), this changelog.
- Team docs: `CONTRIBUTING.md`, `AGENTS.md`, `ROADMAP.md`, the Ironhide protocol.

### Changed
- Hazards are shown from the first report with a confidence tier: very low (<3), low (3–<5), medium (5–<10), high (10+), counting an on-the-spot GPS report as 1 and a no-GPS report as ½, minus "not there" answers, fading over time. (Team, Claude Code, 2026-11-19)
- Reports of the same hazard type within ~200 ft (61m, was 75m) are treated as the same hazard. (Team, Claude Code, 2026-11-19)
- App label shows the tier, e.g. "Very low confidence · 1 report". (Team, Claude Code, 2026-11-19)
- ROADMAP.md: team decisions and a plan to a working demo the week of Dec 2 and the final project on Dec 9. (Team, Claude Code, 2026-11-19)

### Fixed
- BUG-017: hazards could stay shared past their own expiry time because the score was rounded before comparing with the threshold. Regression test added (Ironhide). (Team, Claude Code, 2026-11-19)
- BUG-001 to BUG-016. Details and the regression test guarding each are in `docs/BUGS.md` (Ironhide protocol).

[Unreleased]: #unreleased
[1.0.0]: #100---2026-11-19
