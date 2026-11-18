/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // @offgrid/shared ships TypeScript source directly (no build step yet), so it
  // must be transformed too instead of being treated as plain pre-built JS.
  transformIgnorePatterns: ['/node_modules/(?!@offgrid)'],
};
