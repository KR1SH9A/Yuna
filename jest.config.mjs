/** Run TypeScript's emitted ESM so tests use the same compiler settings as the application. */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/dist/tests'],
  testMatch: ['**/*.test.js'],
  transform: {},
  setupFiles: ['<rootDir>/dist/tests/setup/structured-clone.js'],
  // Tests import their APIs explicitly; keep the application namespace free of Jest globals.
  injectGlobals: false,
};
