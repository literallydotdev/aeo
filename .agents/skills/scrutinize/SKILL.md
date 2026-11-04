---
name: scrutinize
description: Scrutinize the work just performed in this session — verify it is solid, high quality, and aligned with the engineering principles; fix clear-cut violations and report the rest.
argument-hint: '[optional focus, e.g. a file or concern]'
disable-model-invocation: true
---

# Scrutinize

You just finished (or paused) a piece of work. Re-examine it as a skeptical
reviewer who did not write it. The deliverable is an honest verdict, not
reassurance. `$ARGUMENTS` (if given) narrows the focus.

## Protocol

### 1. Fix the scope

Identify exactly what is being scrutinized: files changed this session, plus
`git status` / `git diff` (and the branch's unpushed commits if the work spans
them). If the scope is ambiguous, state what you are scrutinizing before
judging it.

### 2. Re-read, don't recall

Read every changed file in full — not just the hunks you wrote. Most
self-review failures come from judging the diff you remember instead of the
code that exists.

### 3. Judge against the house standards

- The Main Goal — clarity, correctness, ease of change — and the **Practical
  Review Questions** in `docs/engineering-principles.md`. Walk every question
  explicitly; do not skim.
- The topic rules matching the touched areas (`.claude/rules/`):
  - `measurement-stability` when prompts, stages, scoring, profiles, digests,
    cache keys or dependencies changed: is the method version bumped, and is
    the change stated?
  - `evidence-honesty` when the recorder, the journal, export or the verifier
    changed: does anything claim more than was observed?
  - `untrusted-input` when answers, pages, model output or bundles are read
  - `tests-cost-nothing` when tests changed: can any of them spend money or
    reach the network?
  - `public-repository` for every change: is all of it fit to publish?
  - `eslint-suppressions`, `git-operations` as they apply

### 4. Verify mechanically

Run the cheap checks the change warrants: `pnpm typecheck`, `pnpm lint` and
`pnpm test`. When packaging, resources or exports changed, also `pnpm build`
and a pack-and-install into an empty project. Never claim "verified" without
having run something, and never run a `*.live.spec.ts` or a paid command to
verify.

### 5. Report ranked findings

For each finding: `file:line`, the principle or rule violated, the concrete
failure or maintenance cost, and the specific fix. Rank by severity:
anything that spends money twice, changes a measurement silently, overstates
evidence or publishes private data comes first. Keep two categories separate:

- **Violations** — clear breaches of the principles or rules.
- **Judgment calls** — defensible either way; state the tradeoff and a
  recommendation, don't nitpick.

### 6. Fix what's unambiguous

Apply fixes for clear violations that don't change behavior, scope, the
measurement method or public contracts; re-run verification afterward. Leave
judgment calls and anything scope-changing as recommendations. State plainly
what was fixed and what was only flagged.

## Honesty rules

- No rubber-stamping: "looks good" is only a valid conclusion after steps 1–4
  actually happened.
- If the work holds up, say so plainly and stop — do not invent nitpicks to
  appear thorough.
- If something is wrong, say it bluntly — including when the wrong thing was a
  decision you made earlier in the session.
