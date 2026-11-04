# Measurement Stability

Reports compare measurements across months. A comparison is only honest when
both runs measured the same way, so anything that changes how a measurement
is taken is a **method change** and is made deliberately, never as a side
effect.

## What is part of the method

- The audit's measurement inputs: the config fields that enter
  `measurementDigest` (`src/bundle/contracts.ts`), the planned units and their
  run counts (`src/schema.ts`)
- The prompts and stage rules of every Codex stage, and `stageVersions`
  (`src/codex-workflow/schemas.ts`)
- The pinned model profiles and their role digests (`src/models/profiles.ts`)
- Scoring and aggregation (`src/analysis/`, `calculationVersion` in
  `src/bundle/contracts.ts`)
- Cache keys (claim extraction, analysis): their inputs decide what a run
  reuses
- **Runtime dependencies.** They are pinned to exact versions in
  `package.json` because their output is part of the method: zod's JSON
  schema output is hashed into the claim extraction cache key, and the AI SDK
  shapes every request

## The rule

- Change a method input only on purpose, and bump the version that names it
  (a stage version, `calculationVersion`, a profile ID, a cache key's policy
  version) in the same change.
- Never add an input to a digest or cache key silently. A new input changes
  every digest it touches; existing runs then stop matching their baselines.
- Never widen a runtime dependency to a range. Upgrading one is a method
  change: say so in the release notes and expect cache misses.
- Keep `toolVersion` (`src/bundle/contracts.ts`) equal to the package version.
  The build and `src/bundle/version.spec.ts` refuse a mismatch.

## Not method

Run policy (budgets, concurrency, coverage thresholds) and presentation stay
out of the measurement digest. Changing them never makes two runs
incomparable, so they need no version bump.
