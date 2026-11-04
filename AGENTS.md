# literally-aeo

The Literally.dev AEO engine and the `literally-aeo` CLI: a public, MIT
licensed repository (`literallydotdev/aeo`), published to npm as
`literally-aeo`. Literally.dev's hosted service (the private `website`
repository) consumes this package at an exact pinned version; nothing here
knows about it.

## This repository is public

Every file and every commit is published. Never add:

- client or prospect names, domains or audit data (use reserved names:
  `acme.example`, `rival.example`);
- Literally.dev's private company context (positioning, revenue, deals,
  relationships), credentials, internal hostnames or account IDs.

The replay fixture under `src/__fixtures__/replay/literally-2026-q3` is
Literally.dev's own self-audit (assistant answers and the report snapshot),
not client data.

## Commands

| Command              | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm test`          | Vitest: deterministic and free. `*.live.spec.ts` (real models) never run here |
| `pnpm typecheck`     | TypeScript                                                                    |
| `pnpm lint`          | ESLint (the style guide's rules)                                              |
| `pnpm cli <command>` | The CLI from source                                                           |
| `pnpm build`         | `dist/` (CLI, author tool server, library, types) and `resources/`            |

`pnpm typecheck && pnpm lint && pnpm test` is the gate for every change;
CI runs it, then packs and smoke-tests the tarball on Linux x64, Linux arm64
and macOS.

## Layout

- `src/cli/` the command; `src/engine/` local runs, budgets, resources and the
  package root; `src/codex-workflow/` the Codex stages; `src/bundle/` the
  journal, export and offline verifier; `src/report/` the report and
  measurement contracts (`literally-aeo/contracts`).
- `src/author/` and `src/engine/editorial/` are run-time resources, copied
  into `resources/` by the build. Code finds them through
  `engineResources()`, never through a path relative to the working
  directory.
- Every module is importable as `literally-aeo/<path>` (the hosted adapter
  uses this). Only the CLI and `literally-aeo/contracts` are stable API.

## Rules

- TypeScript follows [docs/typescript-style-guide.md](docs/typescript-style-guide.md);
  it is binding, and existing code that breaks it is debt, not precedent.
- Runtime dependencies are pinned to exact versions: the measurement method
  (cache keys, JSON schemas sent to models) depends on them. Changing one is a
  method change and gets its own release note.
- `toolVersion` in `src/bundle/contracts.ts` equals the package version; the
  build and a test refuse a mismatch.
- Git is the user's to run: never run a git command that changes repository
  state (`add`, `commit`, `push`, `tag`, `reset`, `checkout`, ...). Hand the
  user the exact command, naming every path. No `Co-Authored-By:` or
  "Generated with" lines.

## Releasing

Bump `version` in `package.json` and `toolVersion`, merge, then tag
`vX.Y.Z` and push the tag. `release.yml` checks, packs and publishes through
npm trusted publishing (approval in the `npm` environment), with provenance.
