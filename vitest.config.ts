import { configDefaults, defineConfig } from 'vitest/config';

// Every suite here is deterministic and free. Tests that call a real model or
// provider are named *.live.spec.ts and stay out of this run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, '**/*.live.spec.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
