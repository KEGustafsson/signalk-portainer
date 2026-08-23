module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.test.tsx'],
  collectCoverageFrom: ['src/**/*.ts', 'src/**/*.tsx'],
  coverageReporters: ['text-summary', 'lcov'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // jsdom renders and userEvent keystrokes are slow enough that a test
  // taking ~2s alone can pass 5s when all workers are busy. The default
  // turns that contention into spurious failures.
  testTimeout: 30000,
  moduleNameMapper: {
    // webpack inlines stylesheets as strings; jest has no loader for them.
    '\\.css$': '<rootDir>/test/webapp/cssStub.ts',
  },
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
  },
};
