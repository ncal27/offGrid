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

### Changed
- Hazards are shown from the first report with a confidence tier: very low (<3), low (3–<5), medium (5–<10), high (10+), counting an on-the-spot GPS report as 1 and a no-GPS report as ½, minus "not there" answers, fading over time. Replaces the short-lived "3 hikers before anything is shown" rule. (Team, Claude Code, 2026-11-19)
- Reports of the same hazard type within ~200 ft (61m, was 75m) are treated as the same hazard. (Team, Claude Code, 2026-11-19)
- App label now shows the tier, e.g. "Very low confidence · 1 report". (Team, Claude Code, 2026-11-19)
- ROADMAP.md: recorded team decisions and a plan to a working demo the week of Dec 2 and the final project on Dec 9. (Team, Claude Code, 2026-11-19)

### Fixed
- BUG-017: hazards could stay shared past their own expiry time because the score was rounded before comparing with the threshold. Regression test added (Ironhide). (Team, Claude Code, 2026-11-19)

### Removed

### Security

## [1.0.0] - 2026-11-19

The baseline. Everything after this is tracked against it
(`releases/v1.0.0.manifest.json`, git tag `v1.0.0`).

### Added
- Core loop: plan a trail online, download a self-contained trip package, navigate offline by GPS, confirm position by photo, contribute photos and hazard reports offline, sync on reconnect.
- Crowdsourced photo promotion pipeline (2+ independent contributors, or a human reviewer).
- Trail version / update check.
- Waze-style hazard verification: reports merge into incidents with a confidence score built from "still there" / "not there" votes, weighted by GPS proximity, reporter trust and time decay; only confident hazards ship. Offline "Still there?" prompts on mobile. See `docs/HAZARD_VERIFICATION.md`.
- Reviewer endpoints for contributions and hazards (token-protected).
- Image sanitization: every uploaded photo is decoded and re-encoded; metadata/GPS is stripped; decompression bombs, disguised files and animations are refused. See `docs/SECURITY.md`.
- Input validation for all IDs, text, coordinates and timestamps; per-IP rate limiting; security headers.
- CI (typecheck, tests, dependency audit), `npm run check`, change tracking (`npm run changes`), this changelog.
- Team docs: `CONTRIBUTING.md`, `AGENTS.md`, `ROADMAP.md`, the Ironhide protocol.

### Fixed
- BUG-017: hazards could stay shared past their own expiry time because the score was rounded before comparing with the threshold. Regression test added (Ironhide). (Team, Claude Code, 2026-11-19)
- BUG-001 to BUG-016. Details and the regression test guarding each are in `docs/BUGS.md` (Ironhide protocol).

[Unreleased]: #unreleased
[1.0.0]: #100---2026-11-19
