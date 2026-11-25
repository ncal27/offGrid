// Lets the app use shared, platform-agnostic code from the monorepo
// (../mobile/src/core: offline "Where am I?" and the trip planner, which use
// ../packages/shared).
//
// Deliberately narrow, for Windows: watch only the two source folders the app
// needs, map @offgrid/shared straight to its folder (no following npm's
// workspace links/junctions), and resolve every package from app/node_modules
// only. An earlier version watched the whole repo-root node_modules and relied
// on those links; on Windows `expo export` stopped silently right after
// "Starting Metro Bundler" (BUG-022).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(repoRoot, 'mobile', 'src'), path.join(repoRoot, 'packages', 'shared')];
config.resolver.extraNodeModules = { '@offgrid/shared': path.join(repoRoot, 'packages', 'shared') };
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
