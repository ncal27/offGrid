# OffGrid input & image security

How OffGrid handles data it doesn't control: photo uploads, hazard reports,
IDs, free text, and server responses on the phone. Each rule has a test in
`backend/test/integration/securityHardening.test.ts`,
`backend/test/integration/inputValidation.test.ts` or
`mobile/test/integration/untrustedInput.test.ts`. Bug numbers refer to
`docs/BUGS.md`.

## Principles

1. **The backend is the authority.** Mobile checks exist to avoid wasting a
   hiker's storage and data, but a modified app can skip them. Every rule
   below is enforced on the server.
2. **Reject, don't silently "clean" fields.** A bad field gets a `400` with a
   reason, not a quietly altered value. The one deliberate exception is
   images, which are always rebuilt from pixels (below).
3. **Cheapest checks first.** Size and format checks run before anything
   expensive, so junk never costs an image decode.
4. **Fail closed.** Missing configuration (e.g. no reviewer token) disables
   the feature instead of opening it.

## Image uploads (`backend/src/validation/imageValidation.ts`)

Nothing the client sent is stored. The stored photo is a new JPEG
re-encoded from the decoded pixels.

| Step | Check | Stops |
| --- | --- | --- |
| 1 | String, ≤ 12MB of base64 text, before decoding | memory blowups |
| 2 | Strict base64 (linear loop, not regex) | malformed data, the BUG-004 crash |
| 3 | Decoded ≤ 8MB | oversized files |
| 4 | Magic bytes are JPEG, PNG or WebP (`RIFF`+`WEBP`) | text, scripts, SVG, GIF, WAV/AVI (BUG-008), executables |
| 5 | sharp reads the **header only**: format matches the magic bytes, ≤ 40 megapixels, ≤ 12,000px per side, ≥ 16px, single frame | decompression bombs (a 2KB file claiming 50,000×50,000), mislabelled files, tracking pixels, animations |
| 6 | Full decode with `failOn: 'warning'` | truncated or corrupt files, files that only *start* like an image |
| 7 | Re-encode: auto-orient, shrink to ≤ 2048px, flatten alpha, JPEG q85, **all metadata dropped** | EXIF/GPS/camera-serial leaks, hidden appended payloads (polyglots), parser exploits aimed at whoever reads the file later |

sharp is pinned to a release with no known libvips CVEs (`npm audit` is
clean, and CI fails on new high-severity advisories). Image decoders are the
riskiest dependency in this project, so keep it updated.

**Not covered yet** (roadmap item 8): face blurring, nudity and content
moderation, duplicate and near-duplicate detection.

## Text and structured fields (`packages/shared/src/validation.ts`)

- **IDs** (`trailId`, `waypointHintId`, `contributorId`, submission `id`, …):
  `^[A-Za-z0-9_-]{1,128}$`. This blocks path traversal (`../`), URL tricks,
  and injection into storage keys.
- **References must exist.** Unknown trail → `404`. A waypoint hint that
  isn't on that trail → `400` (BUG-005, BUG-006).
- **Enums** (`hazardType`, `severity`) are checked against runtime lists.
- **Coordinates** must be finite, within ±90 / ±180.
- **Timestamps** must parse, and be within ±10 years of now.
- **Free text** (`description`): ≤ 1000 chars, not blank, and no control
  characters, zero-width characters, bidi overrides ("Trojan Source") or
  Unicode line separators (BUG-015). Emoji, accents and newlines are fine.
- **Output encoding is still required.** Validation doesn't make text safe to
  drop into HTML. Any future web dashboard or email must escape it when
  rendering (React does this by default; `innerHTML` doesn't).
- **Unknown JSON keys are ignored.** Validators copy only known fields into
  new objects, so `__proto__` / `constructor` keys can't pollute anything.

## Request-level protections (`backend/src/app.ts`)

- Body limits: 15MB only on `/contributions/photos`, 100kb elsewhere (BUG-010).
- Live OpenStreetMap import (`POST /trails/import`): the search text must be
  2–60 characters from `[A-Za-z0-9 .'&-]` and is escaped before it's put in
  the Overpass query, so it can't change the query. Results are untrusted:
  coordinates must be valid and inside the search area, names must pass
  `isSafeText`, sizes are capped, imports are rate limited with the other
  writes, and at most 50 imported trails are kept.
- Reference photos (Wikimedia Commons): the data builder accepts only free
  licences (CC0, CC BY, CC BY-SA, public domain), only images on Wikimedia's
  own hosts, and validates titles/credits as safe text. Photos are linked, not
  copied, and the credit (photographer, licence, source page) is always shown.
- `GET /photos/:id.jpg` serves only PROMOTED hiker photos (already sanitized
  and re-encoded); pending contributions are never served, and the file name
  is validated before lookup.
- The app's "Go offline" mode blocks every `fetch` at one choke point while
  offline (and counts attempts), so nothing is sent until the user goes back
  online. Photos saved for offline use are kept as images inside the app.
- Voice planning: in browsers, the 🎤 button uses the browser's own speech
  recognition, which sends audio to the browser maker's service (e.g. Google
  for Chrome); it's only available while online. On phones, dictation is the
  keyboard's own feature. The app itself never records or uploads audio.
- Town search for the planner (`near` on `POST /trails/import`): only short
  "Town, ST"-style text is accepted, the geocoder's answer must be a valid
  bounding box, and the search area is capped (0.6° per side) whatever the
  geocoder returns.
- CORS (browser version of the app only): explicit origin allow-list
  (`OFFGRID_CORS_ORIGINS`, default `http://localhost:8081`), never `*`.
- Per-IP rate limit on writes (default 100 per 15 min). Contributor IDs are
  self-reported, so this is the limit that actually holds. Behind a proxy,
  pass `createApp({ trustProxy: 1 })` or every user shares one IP.
- Volume caps: 20 pending per contributor per trail, 500 per trail, and a
  global byte budget for pending images.
- Submission IDs: retrying the same id returns the original answer;
  someone else's id gets a `409` (BUG-007).
- Hazards must be confirmed before they're shared: GPS-proximity-weighted
  votes, time decay, one voice per hiker, and votes from >500m refused. See
  `docs/HAZARD_VERIFICATION.md`. Hazard timestamps can't be in the future
  (they would never decay) or more than 30 days old.
- Review endpoints need `Authorization: Bearer $OFFGRID_REVIEWER_TOKEN`
  (≥ 32 chars, constant-time compare). They're off if the token is unset (BUG-009).
- Errors return a short JSON code and never a stack trace. No `X-Powered-By`;
  `nosniff`, `no-store` and a locked-down CSP are always sent.

## Mobile (`mobile/src/core`)

- IDs are validated and URL-encoded before going into request paths or
  storage keys (BUG-012).
- A downloaded package must be for the trail that was requested.
- The offline queue never gets stuck: permanent rejections go to a
  `rejected()` list for the UI, and transient failures are retried later (BUG-011).
- Non-finite embedding values count as "no match" (BUG-013).

## Known gaps (before any real deployment)

1. **No user accounts.** Contributor and reporter IDs are self-asserted, and
   reviewers share one token. Real auth (e.g. OAuth plus a reviewer role) is
   the biggest missing piece.
2. **A single report is shown** (at "very low" confidence), and confidence
   tiers can be inflated with made-up IDs until real accounts exist. The
   per-IP rate limit, the per-trail cap, the confidence label and reviewer
   rejection limit the damage.
3. **Everything is in memory.** A restart loses pending items, and
   multiple server instances wouldn't share rate-limit or idempotency state.
4. **HTTPS** must be terminated by whatever hosts this. The app itself
   speaks plain HTTP.
5. **Secrets** go in environment variables / `.env` (git-ignored); see
   `backend/.env.example`. Never commit a real token.
