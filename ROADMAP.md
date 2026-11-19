# OffGrid Roadmap

Where the project is going and what's still undecided. This is the
team-level plan; `docs/roadmap.md` is the detailed engineering backlog under
it. When a decision is made, log it in "Decisions made" with the date and
reason.

**Current version:** 1.0.0 (2026-11-19). See `CHANGELOG.md`.
**Goal:** a class project with a **live demo**: working by the **week of Dec 2**,
field-tested on Wellesley trails, and final on **Dec 9**. Free and
open-source tools only; robust enough to demo, not to sell.

## Where we are

Tested core logic for the whole loop: plan, download, navigate offline,
photo-confirm, contribute, report and verify hazards (confidence tiers),
and sync. A hardened backend (input and image sanitization, rate limits,
reviewer auth). 126 automated tests, Ironhide protocol, change tracking.

**Missing for the demo:** an app on a phone, real Wellesley trail data, a
real photo-matching model, sign-in, a database (state is lost on restart),
and face blurring.

## Demo stack (all free)

| Need | Choice | Why |
| --- | --- | --- |
| App on iPhone + Android | **Expo (React Native)**, run through the free **Expo Go** app | No app store, no $99 Apple account. Scan a QR code and it runs. Our core logic is already TypeScript |
| Maps | `react-native-maps` (included in Expo Go) with OpenStreetMap tiles, cached for offline | Works in Expo Go. Native offline-map libraries would need custom builds |
| Trail data | **OpenStreetMap** via the Overpass API, checked against the town's trail maps | Free; covers Wellesley's trails. Must show "© OpenStreetMap contributors" |
| Sign-in | **Supabase anonymous sign-in**: one tap, no passwords | Easiest option, and it gives each phone a server-issued ID, which makes confidence tiers much harder to inflate than self-chosen IDs |
| Database + photo storage | **Supabase** free tier (Postgres + Storage) | Free hosting would otherwise lose all hazards and photos every time the server sleeps |
| API hosting | **Render** free web service (our existing Express backend) | Free. It sleeps after ~15 min idle, so open it a minute before the demo |
| Photo matching | A ready-made, pretrained model (e.g. MobileNet image embeddings via TensorFlow.js). **No custom training** | Decided. Week 1 spike: confirm it runs inside Expo Go; fallback below |
| Face blurring | Open-source face detection on the server before any photo is stored or shared | See privacy decision below |

**Main technical risk:** running a model on the phone inside Expo Go. If the
week-1 spike shows it doesn't work, the fallback for the demo is matching on
the server when there's signal, with GPS-only confirmation offline. The
demo still works; it's just less impressive offline.

## Plan to Dec 9

| When | Release | Goal |
| --- | --- | --- |
| **Nov 19 – 25** | **1.1.0** Foundation | Push to GitHub. Supabase project (database, storage, anonymous sign-in). Store hazards and photos in the database instead of memory. Import 3–5 Wellesley trails from OpenStreetMap. Expo app skeleton: trail list → map → live GPS on the route. Photo-model spike in Expo Go. |
| **Nov 26 – Dec 1** (Thanksgiving week, lighter) | **1.2.0** Demo-ready | Download a trail for offline use. Camera + photo match. Report a hazard; "Still there?" prompt; hazard markers with confidence labels. **Demo-only "simulate another hiker" button** (off unless demo mode is switched on, clearly labelled, simulated votes tagged so they can be wiped). Face blurring. Disclaimer screen. Deploy the API to Render. |
| **Week of Dec 2** | 1.2.x | **Working demo.** Field-test on the pilot trails, collect reference landmark photos, tune the hazard numbers, fix bugs (Ironhide: every fix gets a test). |
| **Dec 8** | **1.3.0** Final | Feature freeze, final release, rehearse the demo. |
| **Dec 9** | — | Due / live demo. |

**Demo-day checklist:** wake the Render server; pre-download the trail on
every demo phone; show navigation in airplane mode; use **3 phones** to show
a hazard's confidence climbing as more "hikers" confirm it (real phones plus
the simulate-a-hiker button).

## Pilot area: Wellesley, MA

Candidate trails. **Not locked in**: the team will look them up and pick 2–3 for field testing.

- **Brook Path / Fuller Brook Park.** Easy, flat, ADA-accessible, ~2.5–3 mi. Good for a safe first test and demo.
- **Centennial Reservation.** Woodland trails and the Maugus Hill view. A good "real hike" test.
- **Rocky Ledges / Boulder Brook Reservation.** Rockier, with distinctive landmarks, which is good for photo matching.
- **Elm Bank Reservation, Riverside Trail.** ~2.5 mi along the Charles River.
- **Sudbury Aqueduct / Waban Arches.** Very recognizable landmark (the arches).

Sources: [Town of Wellesley: Favorite Trail Walks](https://www.wellesleyma.gov/1724/Favorite-Trail-Walks), [MassTrails: Wellesley](https://masstrails.com/wellesley.html), [Swellesley Report: Waban Arches and Sudbury Aqueduct](https://theswellesleyreport.com/2020/01/wellesley-hikes-the-waban-arches-and-sudbury-aqueduct/).

## Decisions made

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-18 | Every bug fix needs a regression test (Ironhide protocol) | Fixed bugs must not come back |
| 2026-11-19 | Hazards verified Waze-style (confidence from nearby confirmations, decaying over time) | Single reports are unreliable; trails change |
| 2026-11-19 | 1.0.0 baseline; every change logged in `CHANGELOG.md`; `npm run changes` catches unlogged edits | Files get edited by several people and AI tools |
| 2026-11-19 | **Code on GitHub** (project lead's personal account for now) | Move to an Organization only if the project outlives the class |
| 2026-11-19 | **Project lead is release owner.** Classmates send changes; lead and Claude review them together and decide what goes in which release | One person decides, so releases stay coherent |
| 2026-11-19 | **iOS and Android via Expo / Expo Go** | Fastest path to a live demo on both, free |
| 2026-11-19 | **Easiest free sign-in** (Supabase anonymous) | Class project, not a product |
| 2026-11-19 | **Free and open-source only** for hosting and tools | No budget |
| 2026-11-19 | **Pilot: Wellesley, MA trails** | Near Babson; the team can field-test them |
| 2026-11-19 | ~~Hazards need 3 different hikers before anyone sees them~~ (replaced the same day, below) | — |
| 2026-11-19 | **Hazards are shown from the first report, with a confidence tier:** very low (1–2 hikers), low (3–<5), medium (5–<10), high (10+). On-the-spot GPS reports count more than no-GPS ones; "not there" and time lower it. Same type within ~200 ft = same hazard. Implemented | Hikers see possible hazards early, and the label tells them how much to trust it |
| 2026-11-19 | **Phones:** 3 iPhones + 1 Android on the team. **Add a demo-only "simulate another hiker" button** | Test and demo multi-hiker features when not everyone is around |
| 2026-11-19 | **Field-test trails: not locked in yet** | Team will look up the candidates first |
| 2026-11-19 | **No AI-usage disclosure needed** in the app (it's an AI class) | — |
| 2026-11-19 | **Blur all faces, especially children's.** If faces are a large part of the photo, reject it and ask the hiker to retake it without people. Landmark photos never need people in them | Privacy |
| 2026-11-19 | **Ready-made photo model; no custom training** | Time and complexity |
| 2026-11-19 | **A short disclaimer is enough** for liability (class project) | See wording below |
| 2026-11-19 | **Shared ownership**: no fixed roles; anyone can work on anything, and the lead reviews | Small team, short timeline |

**Disclaimer wording (draft):** "OffGrid is a student project. Trail and
hazard information is community-reported and may be wrong or out of date.
Always use your own judgment, carry a paper map, and follow posted signs and
park rules."

## Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| Q-B | **Which 2–3 trails to field-test** in the week of Dec 2? | Team to decide after looking them up. My suggestion: Brook Path (easy), Rocky Ledges (landmarks), Waban Arches (most recognizable). |
| Q-C | **GitHub repo name and visibility.** | Private repo named `offgrid`; add classmates as collaborators. |
