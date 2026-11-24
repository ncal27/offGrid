# OffGrid

Plan a hike while you have signal, download it, then navigate fully offline
— no wifi, no cell — using your phone's GPS (which works without a network
connection) plus a photo-based landmark confirmation feature for when GPS is
weak or you just want a sanity check that you're on the right trail.

This repo is V1: the core plan → download → navigate → photo-confirm →
contribute → sync loop, built and tested, with native mobile screens and the
real on-device ML model intentionally not wired up yet (this was built in a
sandbox with no iOS/Android simulator available — see `docs/architecture.md`
for why everything is structured around swappable adapter interfaces instead).

Read **`docs/architecture.md`** first for how the pieces fit together, and
**`docs/roadmap.md`** for what's deliberately not built yet.

## Repo layout

- `packages/shared` — TypeScript types shared by backend and mobile
- `backend` — Express API (trail search/detail, trip package building, contribution intake)
- `mobile` — platform-agnostic core logic + adapter interfaces for native/ML integration
- `docs` — architecture, roadmap, bug log, and security/input-handling rules

## Getting started

```bash
npm install          # installs all workspaces
npm run check        # typecheck + all tests (what CI runs)
npm test             # runs backend + mobile test suites
npm run test:backend
npm run test:mobile
npm run dev:backend  # starts the API on :4000
npm run demo         # end-to-end walkthrough against the real API
```

The phone app lives in `app/` (Expo). **Start with `HANDOFF.md`**: it covers
how to run the app on your phone and what to work on next.

Requires Node 20+. Install, typecheck and all tests run clean (they're also
run by CI on every push/PR, see `.github/workflows/ci.yml`).

To use the photo review endpoints locally, copy `backend/.env.example`,
set `OFFGRID_REVIEWER_TOKEN`, and export it before `npm run dev:backend`.
Without a token they're disabled on purpose.

See **`docs/SECURITY.md`** for how user input and uploaded images are
validated and sanitized, and **`CONTRIBUTING.md`** for the team workflow.
