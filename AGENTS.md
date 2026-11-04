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
CI runs it on Linux, then packs and smoke-tests the tarball. Everything in
CI is free: no step calls a real model or provider. macOS is not tested in
CI (hosted macOS runners queue too long); run `pnpm test` on a Mac before
claiming a macOS fix.

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

## Engineering principles

Optimize for **clarity**, **correctness**, and **ease of change**; a
measurement means the same thing every time, and the evidence never claims
more than was observed. Full rulebook:
[`docs/engineering-principles.md`](docs/engineering-principles.md) (Claude
imports it through `CLAUDE.md`; Cursor mirrors it in
`.cursor/rules/engineering-principles.mdc`; Codex reads it from here).

- Keep it simple
- Avoid repeating knowledge
- Separate concerns
- Prefer explicit code
- Make invalid states hard to express
- Fail fast, before paid work
- A measurement means the same thing every time
- Evidence never claims more than was observed
- Everything a model or a website returns is untrusted
- Never spend money by accident
- Library modules have no side effects at import
- Everything here is public
- Test behavior, deterministically and for free

TypeScript follows [`docs/typescript-style-guide.md`](docs/typescript-style-guide.md):
it is binding, and existing code that breaks it is debt, not precedent.

## Agent harness

One body of guidance for Claude Code, Cursor and Codex. Map and sync rules:
[`docs/agent-harness.md`](docs/agent-harness.md).

- **Git is the user's to run**
  ([`.claude/rules/git-operations.md`](.claude/rules/git-operations.md)):
  never run a git command that changes repository or working-tree state
  (`add`, `commit`, `push`, `tag`, `switch`/`checkout`, `reset`, `stash`,
  `rm`, `config`, or anything with `--force`, `--amend` or `--no-verify`).
  Hand the user the exact command, naming every path; read-only inspection
  (`status`, `diff`, `log`, `show -s`, `blame`) is fine. No `Co-Authored-By:`
  or "Generated with" lines in commits or PRs.
- **Topic rules** live in `.claude/rules/*.md` (Claude loads all of them every
  session), mirrored in `.cursor/rules/*.mdc` with frontmatter. Editing one
  side means syncing the other. Codex: read the matching rule before editing
  its area:
  - `public-repository`: before adding or changing any file, data or comment
  - `measurement-stability`: prompts, stages, scoring, profiles, digests,
    cache keys, dependencies
  - `evidence-honesty`: the recorder, journal, export and verifier
  - `untrusted-input`: anything that reads answers, pages, model output or
    bundles
  - `tests-cost-nothing`: before adding or changing tests or CI
  - `eslint-suppressions`: before adding any `eslint-disable`
  - `git-operations`: before any git command that writes
- **Skills** (user-invoked): `scrutinize` and `scrutinize-wide` (self-review
  of session work against the principles), `code-style` (review of session
  TypeScript against the style guide). Mounted at
  `.claude/skills/<name>/SKILL.md` (Claude `/name`) and
  `.agents/skills/<name>/SKILL.md` (Cursor `/name`, Codex `$name`); the two
  copies stay byte-identical.

## Releasing

Bump `version` in `package.json` and `toolVersion`, merge, then tag
`vX.Y.Z` and push the tag. `release.yml` checks, packs and publishes through
npm trusted publishing (approval in the `npm` environment), with provenance.
