# Literally.dev AEO

Measure how AI assistants answer the questions your buyers ask: whether they
mention you, cite you, and who they recommend instead. `literally-aeo` runs
the audit on your own machine with your own provider keys, and writes a
portable evidence bundle that anyone can verify offline.

```sh
npm install -g literally-aeo
literally-aeo init                       # audit.json and .env.example
literally-aeo doctor --env-file .env     # what a run needs, checked offline
literally-aeo plan                       # what a run would measure and cost
literally-aeo run --env-file .env        # measure; run again to resume
literally-aeo view audit-run             # local, loopback-only viewer
literally-aeo export audit-run           # a deterministic .aeo.zip bundle
literally-aeo verify audit-run.aeo.zip   # offline verification
```

## Requirements

- Node.js 24 or newer on Linux, where it is tested. macOS (Apple silicon)
  is expected to work but is not tested in CI. Windows users run it under
  WSL 2.
- The [Codex CLI](https://github.com/openai/codex), which runs the analysis
  and writing stages.
- An `AI_GATEWAY_API_KEY` (Vercel AI Gateway) for the assistant answers and
  the host model calls, and a DataForSEO login for Google AI Overviews and
  factual grounding searches.
- For coding-agent surfaces, the CLI of each one you measure (Claude Code,
  Codex, Cursor) and its own login.

Nothing is sent to Literally.dev: no telemetry, no account, no upload.
A run contacts only the providers you configure and the sites it checks.

## What a run produces

A run directory holds the captured answers, every judgment, the computed
metrics, the report copy and a hash-chained journal of every operation the
host observed: each probe attempt, each model call with its exact request
and response, each research search and fetch, each technical check, and each
Codex session. `export` turns it into a `.aeo.zip` bundle; `verify`
recomputes the metrics from the bundled judgments, checks every hash and the
journal chain, and states plainly what it could not check.

Verification proves the bundle is internally consistent and unaltered since
export. It cannot prove that a provider really returned an answer: the bundle
is evidence its producer recorded, not a third-party attestation.

## As a library

The command is the supported interface, along with `literally-aeo/contracts`
(the report and measurement schemas). Every other module is importable by its
path, for example `literally-aeo/bundle/verify`, because Literally.dev's
hosted service runs this same engine. Those paths are internal: they can
change in any release, so pin an exact version if you use them.

## Development

```sh
pnpm install
pnpm test          # deterministic and free; *.live.spec.ts files are not run
pnpm typecheck
pnpm lint
pnpm cli plan      # the CLI from source
pnpm build         # dist/ and resources/, as the package ships them
```

Releases publish from this repository's `release.yml` when a `vX.Y.Z` tag is
pushed. The version lives in `package.json` and in `toolVersion`
(`src/bundle/contracts.ts`), which every journal and bundle records; the
build refuses a mismatch.

## License

MIT, copyright Literally AS. See [LICENSE](LICENSE).
