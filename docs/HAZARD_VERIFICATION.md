# Hazard verification (Waze-style)

How OffGrid decides whether a hiker's hazard report gets shown to other
hikers. The code is `backend/src/services/hazardService.ts`, and the tests,
written as hiker scenarios, are `backend/test/integration/hazardReporting.test.ts`
and `mobile/test/integration/hazardConfirmation.test.ts`.

## The idea, borrowed from Waze

Waze's help pages describe a simple loop: drivers report something, other
drivers who pass it are asked **"Still there?"**, and their answers
*lengthen* ("Still there") or *shorten* ("Not there") how long the report
stays on the map. How long a report lasts depends on how many people react
and on the type of report. Waze doesn't publish its exact formula, so the
numbers below are our own starting points, chosen to be easy to explain.
They should be tuned once there's real data.

Sources: [Waze Help: Report road hazards](https://support.google.com/waze/answer/13739290),
[Waze forum: how long hazards stay on the map](https://www.waze.com/discuss/t/newbie-how-long-do-reported-hazards-remain-on-map/64592).

## What's different for hikers

| Waze (drivers) | OffGrid (hikers) |
| --- | --- |
| Always online; answers arrive instantly | Usually offline. Answers are queued on the phone and synced later, so **decay is measured from when the hiker saw it**, not when it synced |
| Lots of traffic: many confirmations | Few people per trail: thresholds are low (≈ 2 hikers) |
| A wrong report wastes a few minutes | A wrong "bridge out" turns people around, and a *missed* one is dangerous. Severity changes how much proof is needed |

## How a report becomes a shared hazard

1. **Reports merge into incidents.** A report on the same trail, of the same
   hazard type, within **75m** of an open incident joins it. A report with
   no position at all (no GPS, no waypoint) never merges with anything.
2. **One voice per hiker.** A report counts as that hiker saying "still
   there". Each hiker's latest answer replaces their earlier one, and a hiker
   can't confirm their own report.
3. **Each voice has a weight:**

   `weight = proximity × trust × decay`

   - **Proximity:** 1.0 if GPS puts them within **150m**; 0.5 with no or
     weak GPS, or 150–500m away; refused (422) beyond **500m**.
   - **Trust:** starts at 1.0, range 0.25–1.5. +0.1 when other hikers
     independently confirm your report; −0.3 when a reviewer rejects a
     hazard you vouched for. Taken as of the moment you voted.
   - **Decay:** halves every *half-life*, by hazard type:

     | Type | Half-life |
     | --- | --- |
     | flooding | 1 day |
     | other | 3 days |
     | downed_tree | 7 days |
     | washout | 14 days |
     | bridge_out | 30 days |

4. **Confidence** = sum of "still there" weights − sum of "not there" weights.
5. **Shared** (shipped in trip packages) while confidence ≥ the threshold for
   its severity:

   | Severity | Threshold | In practice |
   | --- | --- | --- |
   | minor / moderate | 1.5 | two hikers on the spot, or one on the spot + one without GPS |
   | severe | 1.25 | the same, slightly easier |
   | impassable | 0.4 | any single report, shipped as **"Unconfirmed: 1 report"** |

   An incident's severity is what most of its reporters said (ties go to the
   less severe option), so one person can't escalate a "moderate" to
   "impassable" to lower the bar.
6. **Leaves the map** when confidence drops below the threshold:
   - **Resolved:** enough "not there" answers bring it to ≤ 0.
   - **Expired:** nobody re-confirmed it for 3 half-lives.
   - **Reviewer:** resolved or rejected (rejection is permanent).

## Worked examples

- **Two hikers report a downed tree at the creek, both with GPS.** 1.0 + 1.0
  = 2.0 ≥ 1.5, so it's shared, confidence "medium". With no more
  confirmations it decays to 1.5 after ~3 days and drops off. Every "still
  there" pushes that out.
- **The same, but flooding.** Shared, but gone after ~10 hours unless
  someone confirms it again. Floods recede.
- **Two hikers report it but neither had GPS.** 0.5 + 0.5 = 1.0, so it isn't
  shared yet. One more on-the-spot hiker makes it shared.
- **One person reports "bridge out, impassable".** Shared immediately, but
  labelled "Unconfirmed: 1 report". The next hiker who walks up and taps
  "Not there" (1.0) takes it down.
- **Two hikers' flooding reports sync two days late.** Each decayed to 0.25,
  so it isn't shared. The flood is probably gone.

## On the phone (offline)

- Every shared hazard ships with `confidence`, `confidenceLevel`,
  `confirmations`, `denials`, `lastConfirmedAt`, `expiresAt` and `verifiedBy`.
  `hazardConfidenceLabel()` turns that into text like "Confirmed by 4 hikers".
- `OfflineNavigator` (given `hazards` from the package) emits
  `approaching_hazard` once per hazard within 150m. That's the UI's cue to
  warn the hiker and ask "Still there?".
- The answer goes into `HazardVoteQueue`, which syncs to `POST /hazards/votes`
  on reconnect, with `observedAt` set to when the hiker answered.
- Hazards past `expiresAt` are hidden on the phone even with no signal
  (`activeHazards()`).

## API

| Endpoint | Who | What |
| --- | --- | --- |
| `POST /hazards/reports` | hikers | report; returns `incidentId`, `status`, `confidence` |
| `POST /hazards/votes` | hikers | `{ id, incidentId, trailId, vote: 'still_there' \| 'not_there', observedAt, location?, voterId }` |
| `GET /hazards/incidents?trailId=` | reviewers | every incident with its score and status |
| `POST /hazards/:id/verify` | reviewers | strong "still there" (worth 4). Still decays, and hikers can still outvote it |
| `POST /hazards/:id/resolve` | reviewers | hazard is gone |
| `POST /hazards/:id/reject` | reviewers | false report: never shared again, costs vouchers trust |

Reviewer endpoints need `Authorization: Bearer $OFFGRID_REVIEWER_TOKEN`.

## Safeguards against abuse

- Votes from >500m away are refused; votes without GPS count half.
- Future timestamps are refused (they would never decay); observations over
  30 days old are refused.
- One voice per hiker per incident; no confirming your own report.
- Submission ids make retries safe; someone else's id gets a 409.
- Per-IP rate limit, per-trail caps, and at most 200 shared hazards per trail
  (highest confidence first).
- Reviewer rejection is permanent and lowers the trust of everyone who vouched.

## Known limits

- **Hiker IDs aren't authenticated yet**, so someone can invent new IDs that
  start at normal trust. Today the per-IP rate limit is the real bound.
  Reputation becomes meaningful once real accounts exist (roadmap item 10).
- **Trust changes only affect future votes.** This prevents a hazard's own
  confirmation reward from inflating its score, but a troll's *past* votes
  on other hazards keep their original weight until those decay or are
  reviewed.
- **GPS can be spoofed** by a modified app. Proximity checks stop honest
  mistakes and casual abuse, not a determined attacker.
- **All the numbers are guesses.** Tune them with real reports: how often
  hazards get confirmed, how long they really last, how often "impassable"
  turns out wrong.
