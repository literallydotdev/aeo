# Golden replay fixtures

Literally.dev's own self-audit (`literally-2026-q3`), run on 2026-09-04. It
holds no client data: the answers are assistant responses about
Literally.dev's own market, and the snapshot is Literally.dev's own report.

| File | What | Read by |
|------|------|---------|
| `literally-2026-q3/config.json` | The audit's config | `src/pipeline.replay.spec.ts`, `src/agents/*.spec.ts`, `src/analysis/competitor-owned-domains.spec.ts` |
| `literally-2026-q3/snapshot.json` | The run's report snapshot | `src/pipeline.replay.spec.ts`, `src/agents/facts.spec.ts`, `src/agents/narrative-facts.spec.ts` |
| `literally-2026-q3/evidence/` | The run's 19 evidence chunks (one per prompt) | `src/pipeline.replay.spec.ts` |
| `literally-2026-q3.probes.jsonl` | The run's probe store: 285 captured units, every surface, both sections | `src/pipeline.replay.spec.ts` |
| `literally-2026-q3.analysis.jsonl` | 19 search analyses (analyzer v2) and 2 perception extractions (v2), keyed as the analysis store of the time keyed them | No test |
| `literally-2026-q3.domain-labels.json` | The learned domain labels (classifier v1) of the run | No test |

## The replay test

`src/pipeline.replay.spec.ts` copies the probe store into a temporary bank,
opens it with the file store as a resumed run would, and runs
`captureSectionProbes` for both sections of the committed config. The AI
SDK, `fetch`, the agent CLIs and the run journal all fail if reached. The
test asserts that:

- every planned unit is satisfied from the bank and nothing is dispatched;
- the 285 answers agree byte for byte with the committed evidence chunks
  (`buildCaptureManifest` refuses an answer or retrieval log that differs);
- the capture manifest the bank produces keeps its pinned digest.

Lines in the probe store predate unit outcomes and capture metadata: they
carry no `status` and no `captureMetadata`. The file store reads them as
captured records, and the manifest marks them `legacy_preserved_record`.
The replay therefore also pins how legacy rows are read. Three Google AI
Overview rows hold the pre-2026-09-06 sentinel text
(`[Google did not generate an AI Overview for this query]`); new captures
record `noOverview` instead.

## What the replay does not cover

Analysis now runs in the Codex workflow stages, whose caches are keyed
differently, so the replay stops at capture: it does not judge the answers
or reassemble the snapshot. The analysis and domain-label files are a
record of the run and are read by no test. An earlier version of this file
cited `aeo/runner.replay.test.ts`, an end-to-end replay through the
in-process analyzer; that test does not exist in this repository.
