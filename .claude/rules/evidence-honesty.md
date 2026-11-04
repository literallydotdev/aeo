# Evidence Honesty

The run journal and the exported bundle are the evidence a third party
verifies. They record what the host observed, as it happened. Every rule here
exists so the evidence never claims more than that.

## Recording

- The host records; no model is ever asked to describe the run.
- An operation starts **before** its dispatch (`recorder.start`,
  `recorded()`, `startAttempt`) and finishes with its real outcome. If the
  start cannot be recorded, the work is not dispatched.
- Bank paid results before anything else can fail. A bookkeeping failure
  after a paid answer ends the unit as a `persistence` failure; it never
  triggers the request again.
- Objects are written before the event that names them.
- A reused output is recorded as `artifact_reused`, never as a new zero-cost
  response.

## Unknowns stay unknown

- A value the provider did not report is `null`, never filled from what was
  requested. The AI SDK fills `response.modelId` with the requested model when
  the provider names none, so `servedModelOf` treats an equal value as
  unknown.
- An operation without a recorded end is unresolved, not a success.
- Coverage is `declared` only when every writer observed every operation kind
  and a probe operation returned each captured answer byte for byte
  (`src/bundle/trace-coverage.ts`); otherwise it is `partial`, with the gaps
  named.

## Verification re-derives, never trusts

- The verifier recomputes what it can (metrics, digests, coverage) from the
  bundle's own documents and events instead of reading the manifest's claim.
- A check that cannot run says `not_checkable` with the reason. It never
  says `pass`.
- Withheld content (redaction) makes a check `not_checkable`, never `fail`
  and never `pass`.

## When you add a capability

A new kind of paid or network operation gets its own operation kind in
`operationKinds` (`src/bundle/contracts.ts`), is recorded by every writer that
performs it, and is covered by the coverage rule. Until all of that is true,
the export says `partial` and names the gap.
