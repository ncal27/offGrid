// Tests for scripts/changes.mjs (run with `npm run test:scripts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./changes.mjs', import.meta.url).pathname;
const run = (root, ...args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, OFFGRID_ROOT: root }, encoding: 'utf8' });

test('ignores build caches like app/.expo, but still sees real edits (Ironhide: BUG-018)', () => {
  const root = mkdtempSync(join(tmpdir(), 'offgrid-changes-'));
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '## [Unreleased]\n');
    writeFileSync(join(root, 'a.ts'), 'one\n');
    run(root, 'snapshot', '1.0.0');

    mkdirSync(join(root, 'app', '.expo', 'cache'), { recursive: true });
    writeFileSync(join(root, 'app', '.expo', 'cache', 'x.png'), 'cache');
    mkdirSync(join(root, 'app', 'web-build'), { recursive: true });
    writeFileSync(join(root, 'app', 'web-build', 'index.html'), 'build');
    assert.match(run(root, 'diff'), /none: files match the release exactly/);

    writeFileSync(join(root, 'a.ts'), 'two\n');
    const out = run(root, 'diff');
    assert.match(out, /modified {2}a\.ts/);
    assert.doesNotMatch(out, /\.expo|web-build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports nothing changed right after a release snapshot (Ironhide: BUG-019)', () => {
  const root = mkdtempSync(join(tmpdir(), 'offgrid-changes-'));
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '## [Unreleased]\n');
    writeFileSync(join(root, 'VERSION'), '1.0.0\n');
    run(root, 'snapshot', '1.1.0');
    assert.match(run(root, 'diff'), /none: files match the release exactly/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('treats a Windows line-ending re-save as unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'offgrid-changes-'));
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '## [Unreleased]\n');
    writeFileSync(join(root, 'a.md'), 'line 1\nline 2\n');
    run(root, 'snapshot', '1.0.0');
    writeFileSync(join(root, 'a.md'), 'line 1\r\nline 2\r\n');
    assert.match(run(root, 'diff'), /none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
