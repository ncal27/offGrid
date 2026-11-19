# Contributing to OffGrid

**Every change goes in `CHANGELOG.md`** (who, what, why, which tool). See
`AGENTS.md` for the rules AI tools must follow, and `ROADMAP.md` for where
we're headed.

## Where the code lives

**Current setup:** the repo lives on the project lead's personal GitHub
account, and the lead is the release owner (see `ROADMAP.md`). Classmates
send changes (as pull requests, or as files via SharePoint), and the lead
reviews them with `npm run changes` and the changelog before deciding which
release they go in. If the project outlives the class, move it to a GitHub
Organization (free; Settings → Transfer) so it doesn't depend on one account.
The steps below are for that later move.

One-time setup (whoever does it):

1. github.com → your avatar → **Your organizations** → **New organization** →
   **Free**. Name it after the team/project (e.g. `offgrid-team`).
2. **People** → invite every teammate. Make **at least two people Owners**.
3. **New repository** inside the org: name `offgrid`, **Private** (it's
   coursework). Don't add a README/license/.gitignore; this repo already has them.
4. Push this code (from the project folder):

   ```bash
   git remote add origin https://github.com/<org>/offgrid.git
   git push -u origin main
   ```

5. **Settings → Rules → Rulesets → New branch ruleset** for `main`:
   require a pull request with 1 approval, require the **CI / check**
   status check to pass, and block force pushes.
6. Optional: add your instructor as a collaborator with **Read** access.

## Day-to-day workflow

1. `git switch main && git pull`
2. `git switch -c <your-name>/<short-topic>`, e.g. `sam/hazard-review-endpoint`
3. Make the change, then `npm run check` (typecheck + all tests).
4. Push and open a pull request. CI runs the same check. A teammate reviews.
5. Squash-merge once approved and green.

Split up work with GitHub Issues (one per bug or feature, assign it to
yourself before starting), so two people don't fix the same thing.

## Rules of the road

- **Never commit secrets.** `.env` is git-ignored; use `backend/.env.example`
  as the template. If a token is ever pushed, rotate it. Deleting the commit
  isn't enough.
- **Touching a route, validator, or upload handling?** Read `docs/SECURITY.md`
  first and add a test for the abuse case, not just the happy path.
- **Found a bug?** Log it in `docs/BUGS.md` (next number, what happened,
  how it was caught) as well as fixing it.
- **Tests are written as user scenarios** (see existing files). Photo-upload
  tests must use real images from `backend/test/helpers/images.ts`.
- **Dependencies:** pin exact versions for anything that parses untrusted
  input (e.g. `sharp`), and keep `npm audit` clean. CI fails on high-severity
  advisories.

## Working from SharePoint (or any shared folder)

If you got the project as files rather than from git:

1. Copy the folder somewhere local (not inside the SharePoint/OneDrive sync
   folder) before running `npm install`. `node_modules` is huge and will
   choke the sync.
2. Before you start, run `npm run changes`. It shows what already differs
   from the last release, so you know what's yours and what isn't.
3. Make your changes (by hand or with any AI tool), then run `npm run check`.
4. Run `npm run changes` again and make sure every file it lists is described
   in `CHANGELOG.md` under `[Unreleased]`. It warns if nothing is logged.
5. Upload only the files you changed, plus `CHANGELOG.md`. Never upload
   `node_modules`, and never edit anything in `releases/`.

## Versioning

[Semantic Versioning](https://semver.org/), `MAJOR.MINOR.PATCH`:

- **PATCH** (1.0.1): bug fixes only.
- **MINOR** (1.1.0): new features that don't break existing data or APIs.
- **MAJOR** (2.0.0): breaking changes, e.g. a changed trip-package format
  that old app versions can't read.

To cut a release (the release owner does this):

1. `npm run check` passes and `CHANGELOG.md` `[Unreleased]` is complete.
2. Move the `[Unreleased]` entries under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading and set `"version"` in every `package.json`.
3. `npm run release:snapshot -- X.Y.Z` records the baseline in `releases/`
   and updates `VERSION`.
4. In git: commit, then `git tag vX.Y.Z`. On SharePoint: also upload a zip
   named `offgrid-vX.Y.Z.zip` to a `Releases` folder. Never overwrite one.

**Rolling back:** restore the files from the last good release (the git tag,
or the release zip), log it in the changelog under `### Removed` with the
reason, and cut a new PATCH or MINOR version. Never re-use or edit an old
version number.
