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
    // Uncapped, vitest sizes its pool to the whole machine: on 20 cores, 19
    // workers that each load the engine (measured 2026-11-08: about 350 MB
    // for the first worker and 130 to 250 MB for each one after it), plus the
    // fake CLIs they start. Four keeps a full run near 1 GB on any machine.
    maxWorkers: 4,
    // Headroom over the 5 s default: on a loaded machine the first test in a
    // file pays for that file's transform. A genuine hang still fails.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
