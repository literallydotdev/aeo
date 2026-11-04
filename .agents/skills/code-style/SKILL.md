---
name: code-style
description: Review the TypeScript written in this session against the TypeScript style guide — syntax, formatting, naming, types, errors, tests; fix clear-cut violations and report the rest.
argument-hint: '[optional focus, e.g. a file or section of the guide]'
disable-model-invocation: true
---

# Code Style

You just finished (or paused) writing TypeScript. Re-examine it as a strict
reviewer who knows `docs/typescript-style-guide.md` by heart and did not
write the code. The deliverable is an honest verdict, not reassurance.
`$ARGUMENTS` (if given) narrows the focus to a file, a folder, or a guide
section.

## Protocol

### 1. Fix the scope

Identify exactly what is being reviewed: TypeScript and shell files changed
this session, plus `git status` / `git diff` (and the branch's unpushed
commits if the work spans them). Other languages are out of scope. If the
scope is ambiguous, state what you are reviewing before judging it.

### 2. Load the guide

Read `docs/typescript-style-guide.md` in full, every time. Do not review from
memory of it; the guide is the standard, and it changes.

### 3. Re-read, don't recall

Read every file in scope in full — not just the hunks you wrote. Style drift
hides in the lines around a change: an import block, a sibling function, a
spec next to the module.

### 4. Walk the guide

Go section by section and check the code against each rule that applies:

1. Tooling and gates (scripts chained with `&&`, no scaffolding leftovers)
2. Vertical rhythm
3. Naming (files, identifiers, units, UPPER_SNAKE for external values, one
   spelling per term)
4. Modules (named exports, import order, `import type`, barrels)
5. Functions (arrow constants, guards, at most two positional parameters,
   async and batch rules)
6. Types (`type`, `as const` enum objects, `unknown` at entry points,
   narrowing instead of casting, classes)
7. Data and control flow (no mutation of inputs, `??`, conditional spread on
   `undefined`, braces, loops, units on numbers)
8. Errors (sentences ending in a period, `cause`, deliberate boundaries,
   idempotency by error type)
9. Logging (shared logger, `'Label:', value`, no `console.*`)
10. Configuration and secrets
11. Comments (why not what, no commented-out code, one-line suppressions
    with `-- reason`)
12. Project layout
13. Tests
14. Shell scripts

Finish with **Appendix C: review checklist**, answering every item
explicitly. Do not skim.

### 5. The guide is the standard

The guide is binding. Existing code that breaks it is not a precedent, and
"the surrounding file does it this way" is not an excuse.

- The only exceptions are the ones the guide itself lists: config files
  (`*.config.ts`) may use default exports, `.d.ts` files may use `interface`
  for module augmentation, and so on. Cite the exception when you rely on it.
- Code written or changed this session must follow the guide, even inside
  files that don't yet. Violations in those lines are **violations**, not
  judgment calls.
- Pre-existing violations elsewhere in a touched file are reported too, as
  migration debt with a count, so they can be fixed in a dedicated change.
- If the repo's ESLint or TypeScript config fails to enforce a guide rule,
  report the missing rule as a finding. The config should catch it, not the
  reviewer.

### 6. Verify mechanically

Run the checks the change warrants: `pnpm typecheck`, `pnpm lint`, and
`pnpm test` when logic changed. Never run a `*.live.spec.ts` or any paid
command to verify. Never claim "verified" without having run something.

### 7. Report ranked findings

For each finding: `file:line`, the guide section and rule violated, the
concrete failure or maintenance cost, and the specific fix. Rank by
severity: correctness and security rules (casts, `||` defaults, mutation,
floating promises, swallowed errors, secrets) before naming and formatting.
Keep two categories separate:

- **Violations** — breaches of the guide in code written or changed this
  session.
- **Migration debt** — pre-existing breaches in touched files, and guide
  rules the lint or TypeScript config doesn't enforce yet; counted and
  listed, with the fix.
- **Judgment calls** — cases the guide leaves open, or where applying a rule
  is defensible either way; state the tradeoff and a recommendation, don't
  nitpick.

### 8. Fix what's unambiguous

Fix every violation in session code that doesn't change behavior or public
contracts, then re-run verification. Leave these as recommendations:

- judgment calls
- migration debt outside the session's lines
- renames that ripple across files
- anything that changes behavior

State plainly what was fixed and what was only flagged.

## Honesty rules

- No rubber-stamping: "clean" is only a valid conclusion after steps 1–6
  actually happened.
- If the code holds up, say so plainly and stop — do not invent nitpicks to
  appear thorough.
- If something is wrong, say it bluntly — including when the wrong thing was
  a decision you made earlier in the session.
