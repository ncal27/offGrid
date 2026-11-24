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
- `npm run demo`: end-to-end walkthrough against the real API (plan, download, hazard tiers climbing with confirmations, photo upload, bad input refused). (Team, Claude Code, 2026-11-24)
- Expo app skeleton in `app/` (SDK 58): disclaimer, trail list, trip download, drawn route with hazards coloured by confidence tier, report hazard, "Not there", and a "Demo: simulate another hiker" button. Runs in Expo Go and in a browser. (Team, Claude Code, 2026-11-24)
- Backend CORS for the browser version of the app: explicit allow-list only (`OFFGRID_CORS_ORIGINS`, default `http://localhost:8081`), never a wildcard. Tested. (Team, Claude Code, 2026-11-24)
- `HANDOFF.md`: how to run everything, and the next tasks in priority order. CI now also typechecks the app. (Team, Claude Code, 2026-11-24)

### Changed
- Release tags are named `X.Y.Z` without a "v" (e.g. `1.0.0`), matching the published 1.0.0 release; docs updated. (Team, Claude Code, 2026-11-19)

### Fixed
- BUG-018: `npm run changes` no longer lists Expo build caches (`.expo`, `web-build`) as changes. BUG-019: cutting a release no longer leaves `VERSION` reported as changed. Both have regression tests in `scripts/changes.test.mjs`, now part of `npm run check` and CI. (Team, Claude Code, 2026-11-24)

### Removed

### Security

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
