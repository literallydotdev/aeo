---
name: scrutinize-wide
description: Scrutinize the work just performed AND its surroundings — zoom out one hop into adjacent modules, callers, and contracts to verify the change fits the wider picture and the engineering principles.
argument-hint: '[optional focus, e.g. a module or concern]'
disable-model-invocation: true
---

# Scrutinize Wide

Everything `/scrutinize` does, plus a zoom-out: the work is judged not just on
its own quality but on how it sits in the neighborhood it landed in. The
deliverable is an honest verdict on both. `$ARGUMENTS` (if given) narrows the
focus.

## Protocol

### 1. Run the scrutinize protocol first

Read `.agents/skills/scrutinize/SKILL.md` and execute it in full — scope,
re-read, judge against `docs/engineering-principles.md` and the matching topic
rules, verify mechanically. Do not repeat its steps here; do them.

### 2. Map the neighborhood — one hop out

Widening is bounded: **one hop** from the changed code, not a repo audit.
The neighborhood is:

- **Callers and consumers** — grep for usages of every export the work added
  or changed. Every module is also a package subpath
  (`literally-aeo/<path>`), so an export may have consumers outside this
  repository: treat a changed export as a contract change.
- **Siblings** — the other modules in the same directory (`src/bundle/`,
  `src/codex-workflow/`, `src/probes/`...), and their specs and fixtures.
- **Contracts touched** — the bundle and journal contracts
  (`src/bundle/contracts.ts`), the report contracts (`src/report/`), the
  audit file schema, the stage schemas and versions, the storage ports
  (`src/stores/ports.ts`), the CLI's commands and exit codes, and the
  package's `exports` and `files`.

Read what you find — enough to judge fit, not to rewrite it.

### 3. Judge the fit against the wider picture

With the neighborhood in view, ask:

- **Duplicate knowledge** — does the new code re-implement something that
  already exists nearby (a helper, a schema, a port, a recorder wrapper)?
- **Consistency** — do adjacent modules follow a pattern the new work
  deviates from? If so, decide which side is right: conform the new work, or
  flag the neighbors as the outdated party.
- **Layering** — does the change respect the CLI / engine / workflow and
  stages / contracts and stores layers, or does it quietly bend them? Does a
  library module gain a side effect at import?
- **One source of truth** — are contracts, versions and digests still aligned
  after the change, or did it fork a parallel representation?
- **Method and evidence** — does a neighbor's measurement or evidence now
  mean something different because of this change (a shared helper whose
  output feeds a digest, a recorder wrapper another writer relies on)?
- **Ripple effects** — did the change leave adjacent code stale: dead
  exports, orphaned helpers, specs, fixtures, README or docs that now
  describe the old behavior?
- **Abstraction pressure** — did this change create real reuse pressure that
  now justifies an extraction, or strand an existing abstraction with a single
  caller? (Per "When to Abstract": respond to pressure, don't anticipate it.)

### 4. Report ranked findings, scoped honestly

Same format as scrutinize (`file:line`, principle, cost, fix, severity;
violations separate from judgment calls), but split findings by territory:

- **In the session's work** — yours to fix; apply unambiguous fixes and
  re-verify, exactly as scrutinize prescribes.
- **In adjacent code** — pre-existing debt the wide pass uncovered. Do **not**
  fix it uninvited: drive-by refactors expand scope silently. Report it, and
  for anything worth keeping, offer to open a GitHub issue for it so it
  enters the backlog instead of evaporating.

## Honesty rules

The scrutinize honesty rules apply unchanged. Additionally:

- Distinguish "the work doesn't fit the neighborhood" from "the neighborhood
  is wrong" — both are legitimate findings; say which one you mean.
- A clean wide pass is a real result: if the change sits well in its
  surroundings, say so and stop. Do not widen past one hop to find something.
