# Tests Cost Nothing

`pnpm test` and CI must never spend money or depend on the network. A suite
that costs money to run stops being run.

## The rule

- Every model, provider, search API and agent CLI is faked in tests: mock the
  AI SDK (`vi.mock('ai')`), inject the transport or the tools, or use the fake
  CLI in `src/probes/__fixtures__/fake-cli/`.
- Pin real-world shapes with captured fixtures (`__fixtures__/`), replayed
  offline. Captured fixtures follow the public repository rule: no client
  data.
- A test that calls a real model, provider or CLI is named `*.live.spec.ts`.
  Vitest excludes those from `pnpm test`, and CI never runs them. Running one
  is a deliberate, paid act by a maintainer, through `vitest.live.config.ts`
  with the settings the suite names; each suite says what it spends.
- No test reads the developer's environment for credentials, or reaches a
  real host. Use `vi.stubEnv` with fake values.

## CI

CI runs typecheck, lint, the test suite and a pack-and-install smoke test, on
Linux only. Hosted macOS runners queue too long to gate every push. If a
change is macOS-specific, run `pnpm test` on a Mac before claiming the fix.
