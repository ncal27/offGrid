# Contributing to OffGrid

## Where the code lives

The repo belongs to a **GitHub Organization** for the team, not to any one
person's account, so nobody's account is a single point of failure and
anyone can leave the team without taking the project with them.

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
