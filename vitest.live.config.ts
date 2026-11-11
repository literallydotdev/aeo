import { defineConfig } from 'vitest/config';

// The paid suites: every *.live.spec.ts calls a real model or provider, and
// running this config is a deliberate act by a maintainer. `pnpm test` and
// CI use vitest.config.ts, which excludes these files. Each suite refuses
// to start without its own settings, read from the process environment:
//
//   AI_GATEWAY_API_KEY=... AEO_LIVE_OUTPUT_DIR=/path/outside/the/repo \
//     capped npx vitest run --config vitest.live.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.live.spec.ts'],
    // One call at a time: what a suite spends is what it lists.
    fileParallelism: false,
    // A search-required call and its synthesis follow-up, each bounded by
    // the adapter at 180 seconds.
    testTimeout: 400_000,
    hookTimeout: 30_000,
  },
});
