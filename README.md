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
- `docs` — architecture and roadmap

## Getting started

```bash
npm install          # installs all workspaces
npm test             # runs backend + mobile test suites
npm run test:backend
npm run test:mobile
npm run dev:backend  # starts the API on :4000
```

No build step has been run as part of creating this repo — `npm install`
and `npm test` have not been executed in this environment (no shell was
available), so run them first thing to confirm everything installs and
passes cleanly before building on top of it.
