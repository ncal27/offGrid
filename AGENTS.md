# Instructions for AI coding tools

This file is read automatically by many AI coding tools (Codex, Cursor,
Copilot, Jules, and others). Claude Code reads `CLAUDE.md`, which has the
same rules plus a full architecture guide; read that too.

If you are an AI tool editing this project, follow these rules. If you are a
person using one, make sure it did.

1. **Log every change in `CHANGELOG.md`** under `[Unreleased]`, in the right
   group, as `- <what and why>. (<person>, <tool>, <YYYY-MM-DD>)`. Use your
   tool's name (e.g. "Cursor", "Copilot"), not just "AI". No silent edits.
2. **Ironhide protocol:** every bug fix needs a regression test that fails
   with the bug present and passes with the fix, tagged
   `(Ironhide: BUG-NNN)`. Log the bug in `docs/BUGS.md` and add it to the
   table there. Never delete or weaken an existing Ironhide test.
3. **Run `npm run check`** (typecheck + all tests) before saying you're
   done, and report the result honestly.
4. **Security:** read `docs/SECURITY.md` before touching routes, validation
   or uploads. Never store client-uploaded image bytes directly, never
   commit secrets, and never loosen a validator to make a test pass.
5. **Hazard rules** are documented in `docs/HAZARD_VERIFICATION.md`. If you
   change a threshold or weight, update that doc and say why in the changelog.
6. **Don't edit `releases/`.** Release snapshots are the baseline that
   `npm run changes` compares against and must never be modified.
7. **Keep it lean:** small focused changes. Don't reformat or rename files
   you weren't asked to touch, because it buries the real change in noise.
