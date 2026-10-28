/** Run TypeScript's emitted ESM so tests use the same compiler settings as the application. */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/dist/tests'],
  testMatch: ['**/*.test.js'],
  transform: {},
  setupFiles: ['<rootDir>/dist/tests/setup/structured-clone.js'],
  // Tests import their APIs explicitly; keep the application namespace free of Jest globals.
  injectGlobals: false,
  // V8 measures the compiled code; source maps point reports back to the TypeScript owners.
  coverageProvider: 'v8',
  collectCoverageFrom: ['dist/src/**/*.js', 'dist/apps/**/*.js', '!**/*.d.ts'],
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
};
