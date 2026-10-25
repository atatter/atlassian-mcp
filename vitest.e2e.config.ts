import { defineConfig } from 'vitest/config';

// Runs the built CLI against a fake Jira and the real OS keychain. See test/e2e.test.ts.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
