// Guards the app's bundler config (run with `npm run test:scripts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILE = process.env.OFFGRID_METRO_CONFIG ?? new URL('../app/metro.config.js', import.meta.url).pathname;

test('app bundler config stays narrow: no repo-root node_modules, no following workspace links (Ironhide: BUG-022)', () => {
  const src = readFileSync(FILE, 'utf8');
  const watch = /config\.watchFolders\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
  assert.ok(watch, 'watchFolders must be set explicitly');
  assert.doesNotMatch(watch, /node_modules/, 'watching the repo-root node_modules made `expo export` exit silently on Windows');
  assert.match(src, /disableHierarchicalLookup\s*=\s*true/, 'packages must resolve from app/node_modules only');
  assert.match(src, /extraNodeModules[\s\S]*'@offgrid\/shared'/, '@offgrid/shared must map straight to packages/shared');
  const pkg = JSON.parse(readFileSync(new URL('../app/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['jpeg-js'], 'the app needs its own jpeg-js (shared code uses it)');
});
