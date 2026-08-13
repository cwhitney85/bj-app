import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `src/table/tableState.ts` only. The components and the hook need a
    // renderer and are not covered here — see PLAN's known gaps.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
