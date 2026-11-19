# OffGrid Roadmap

Where the project is going, and the decisions still open. This is the
team-level plan. `docs/roadmap.md` is the detailed engineering backlog that
sits under it. Update this file when a decision is made: move the question
to "Decisions made" with the date and the reasoning.

**Current version:** 1.0.0 (2026-11-19). See `CHANGELOG.md`.

## Where we are (1.0.0)

Working, tested core logic for the full loop: plan, download, navigate
offline, photo-confirm, contribute, report and verify hazards (Waze-style),
and sync. A hardened backend (input and image sanitization, rate limits,
reviewer auth). 126 automated tests, Ironhide protocol in place.

**Not there yet:** no app you can install (logic only, no screens), no real
trail data (one sample trail), no real photo-matching model (faked in tests),
no user accounts, no database (everything resets on restart).

## Proposed phases

Proposed order. Confirm or reshuffle when answering the questions below.

### 1.1: Team-ready foundation
- Shared home for the code: a GitHub Organization (recommended) and/or SharePoint (see Q1)
- Agree the versioning and release process (Q2)
- Persistence: a real database and photo storage, so data survives restarts (Q5)

### 1.2: Real users
- User accounts and sign-in (Q4). This makes reputation and abuse limits meaningful.
- Reviewer accounts and roles instead of a shared token
- Safety disclaimer and terms for hazard info (Q11)

### 2.0: An app on a phone
- React Native app: map, navigation, camera, "Still there?" prompts (Q3)
- Offline map tiles for downloaded trails
- Real trail data for a pilot area (Q6)

### 2.x: Smarter
- Real on-device photo-matching model (Q9)
- Photo moderation and privacy: face blurring, sensitive locations (Q8)
- Tune hazard thresholds from real reports (Q7)
- Photo-based trail-condition detection ("is this washed out?")
- Safety extras: breadcrumb trail for backtracking, offline emergency info

## Open questions

Each one includes my recommendation, so a quick yes/no is enough.

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Where does the code live?** SharePoint is fine for sharing docs and release zips, but a git repo is much safer for code. Syncing a `.git` folder through SharePoint/OneDrive can corrupt it, and file-level merges between people editing at the same time are painful. | GitHub Organization as the source of truth for code. SharePoint holds release zips and the docs non-coders need. `npm run changes` is the safety net either way. |
| Q2 | **Versioning and release process.** Who decides when something becomes 1.1.0? How are features cut? | SemVer (`MAJOR.MINOR.PATCH`). One person is "release owner" per cycle. Releases at milestones (e.g. per class deliverable). Cut a feature by reverting it to the last release, or put risky features behind an on/off setting. |
| Q3 | **Which phones, which framework?** iOS, Android or both? | React Native with Expo, both platforms. The core logic is already TypeScript, built to plug into it. |
| Q4 | **Sign-in method?** | Start simple: Google/Apple sign-in through one auth service (e.g. Firebase Auth or Supabase). Avoid building our own passwords. |
| Q5 | **Hosting and database, and budget?** | A free tier to start (e.g. Supabase or Firebase for database, auth and storage together; Render/Railway/Fly for the API). |
| Q6 | **Pilot area?** Which trails first? | One park or region you can actually hike and test in, rather than "everywhere". |
| Q7 | **Hazard policy.** Should a single "impassable" report be shared right away (currently yes, labelled unconfirmed)? Who are reviewers: the team, or ranger/park partners? | Keep it as is for now. Team members act as reviewers until there's a partner. |
| Q8 | **Photo privacy policy.** Blur faces automatically? Block photos near sensitive sites (nests, archaeological sites)? | Yes to automatic face blurring before any photo is shared. Sensitive-site rules decided per pilot area. |
| Q9 | **Who owns the photo-matching model?** Train our own or use a pretrained one? | Use a pretrained, phone-sized model first and measure it on pilot-trail photos. Only train our own if it isn't accurate enough. |
| Q10 | **Class scope and deadline.** What must be demo-able, and by when? | Tell me the date and the must-haves, and I'll re-order the phases to fit. |
| Q11 | **Liability.** Hazard info could be wrong in either direction. | A clear in-app disclaimer: "community-reported, may be inaccurate, use your judgment". Check with your instructor whether the class needs anything formal. |
| Q12 | **Team roles.** Who owns what (backend, app, data, ML, docs/release)? | Name an owner per area so reviews and decisions don't stall. |

## Decisions made

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-18 | Every bug fix needs a regression test (Ironhide protocol) | Fixed bugs must not come back |
| 2026-11-19 | Hazards are verified Waze-style (confidence from nearby confirmations, decaying over time) | Single reports are unreliable; trails change |
| 2026-11-19 | 1.0.0 baseline; all changes logged in `CHANGELOG.md`; `npm run changes` detects unlogged edits | Files will be edited by several people and AI tools, often outside git |
