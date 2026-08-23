module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.test.tsx'],
  collectCoverageFrom: ['src/**/*.ts', 'src/**/*.tsx'],
  coverageReporters: ['text-summary', 'lcov'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
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
