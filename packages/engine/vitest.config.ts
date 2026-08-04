import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The simulation harness (SPEC §8) runs 10M hands and is excluded from the
    // default suite; CI runs it nightly via `npm run sim`.
    exclude: ['test/**/*.slow.test.ts', 'node_modules/**'],
  },
});
