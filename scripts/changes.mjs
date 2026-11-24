#!/usr/bin/env node
/**
 * Change tracking that works WITHOUT git, for when the project is passed
 * around as files (SharePoint, OneDrive, zip, email) and edited by people
 * and AI tools that may not keep the git history.
 *
 *   npm run changes                      # what changed since the last release?
 *   npm run release:snapshot -- 1.1.0    # record a new release baseline
 *
 * A release snapshot (releases/vX.Y.Z.manifest.json) is a fingerprint
 * (SHA-256) of every project file at that release. `changes` compares the
 * current files to the newest snapshot and lists added, modified and removed
 * files, whether or not anyone logged them in CHANGELOG.md. Line endings
 * (CRLF vs LF) are ignored, so re-saving a file on Windows doesn't count as
 * a change.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// OFFGRID_ROOT lets tests point the script at a scratch folder.
const ROOT = process.env.OFFGRID_ROOT ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RELEASES = join(ROOT, 'releases');
// Build output and caches git also ignores. Without '.expo'/'web-build', every
// app build showed up as unlogged changes (BUG-018).
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'releases', '.vs', '.idea', '.expo', 'web-build']);
const IGNORE_FILES = [/\.zip$/i, /\.log$/i, /^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^~\$/, /^\.env$/];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && !IGNORE_FILES.some((re) => re.test(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function fingerprint(file) {
  let buf = readFileSync(file);
  // Treat as text (normalize CRLF -> LF) unless it contains a NUL byte.
  if (!buf.includes(0)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(buf).digest('hex');
}

function currentFiles() {
  const files = {};
  for (const f of walk(ROOT)) files[relative(ROOT, f).split(sep).join('/')] = fingerprint(f);
  return files;
}

const semver = (v) => v.split('.').map(Number);
function latestManifest() {
  if (!existsSync(RELEASES)) return null;
  const versions = readdirSync(RELEASES)
    .map((n) => /^v(\d+\.\d+\.\d+)\.manifest\.json$/.exec(n)?.[1])
    .filter(Boolean)
    .sort((a, b) => {
      const [x, y] = [semver(a), semver(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  if (!versions.length) return null;
  const v = versions[versions.length - 1];
  return JSON.parse(readFileSync(join(RELEASES, `v${v}.manifest.json`), 'utf8'));
}

const [cmd = 'diff', arg] = process.argv.slice(2);

if (cmd === 'snapshot') {
  if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error('Usage: npm run release:snapshot -- <version>   e.g. 1.1.0');
    process.exit(1);
  }
  const out = join(RELEASES, `v${arg}.manifest.json`);
  if (existsSync(out)) {
    console.error(`releases/v${arg}.manifest.json already exists. Releases are immutable; pick a new version.`);
    process.exit(1);
  }
  mkdirSync(RELEASES, { recursive: true });
  // Write VERSION *before* fingerprinting. Doing it after meant the snapshot
  // held the old version number, so right after a release `npm run changes`
  // reported VERSION as modified (BUG-019).
  writeFileSync(join(ROOT, 'VERSION'), `${arg}\n`);
  const files = currentFiles();
  writeFileSync(out, JSON.stringify({ version: arg, createdAt: new Date().toISOString(), files }, null, 2) + '\n');
  console.log(`Recorded release ${arg} (${Object.keys(files).length} files) in releases/v${arg}.manifest.json`);
  console.log('Next: move the "Unreleased" notes in CHANGELOG.md under this version, and set "version" in each package.json.');
} else if (cmd === 'diff') {
  const base = latestManifest();
  if (!base) {
    console.error('No release snapshot found in releases/. Run: npm run release:snapshot -- 1.0.0');
    process.exit(1);
  }
  const now = currentFiles();
  const added = Object.keys(now).filter((f) => !(f in base.files));
  const removed = Object.keys(base.files).filter((f) => !(f in now));
  const modified = Object.keys(now).filter((f) => f in base.files && base.files[f] !== now[f]);
  console.log(`Changes since release ${base.version} (${base.createdAt.slice(0, 10)}):`);
  if (!added.length && !removed.length && !modified.length) {
    console.log('  none: files match the release exactly.');
  } else {
    for (const f of added.sort()) console.log(`  + added     ${f}`);
    for (const f of modified.sort()) console.log(`  ~ modified  ${f}`);
    for (const f of removed.sort()) console.log(`  - removed   ${f}`);
    const logged = statSync(join(ROOT, 'CHANGELOG.md'), { throwIfNoEntry: false })
      ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
      : '';
    const unreleased = /## \[Unreleased\]([\s\S]*?)(\n## \[|$)/.exec(logged)?.[1] ?? '';
    if (!/^\s*-\s+\S/m.test(unreleased)) {
      console.log('\n  WARNING: files changed but CHANGELOG.md has no entries under [Unreleased].');
      console.log('  Whoever (or whichever AI tool) made these changes should describe them there.');
    }
  }
} else {
  console.error(`Unknown command "${cmd}". Use: diff | snapshot <version>`);
  process.exit(1);
}
