// Lets the app import shared, platform-agnostic code from the monorepo
// (e.g. ../mobile/src/core/imageFingerprint.ts for offline "Where am I?"),
// and find packages installed at the repo root (e.g. jpeg-js).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(repoRoot, 'mobile', 'src'), path.join(repoRoot, 'packages'), path.join(repoRoot, 'node_modules')];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules'), path.join(repoRoot, 'node_modules')];

module.exports = config;
