import { defineConfig } from 'vitest/config';

/**
 * The simulation harness only (SPEC §8). `vitest.config.ts` excludes these so a
 * normal `npm test` stays fast; this config runs exactly the files that one
 * skips. CI invokes it nightly and on release branches via `npm run sim`.
 *
 * No timeout: the default 5s would kill a 10M-hand run within the first
 * thousandth of it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.slow.test.ts'],
    testTimeout: 0,
    hookTimeout: 0,
  },
});
