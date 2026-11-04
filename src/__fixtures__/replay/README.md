# Golden replay fixtures

The Literally.dev self-audit (`literally-2026-q3`) is not confidential: its
answers are already committed as evidence under
`content/aeo-insights/literally-2026-q3/`. Its run state is therefore
committed here so the runner can be replayed end to end without a network
(hardening spec §6.1, test: `aeo/runner.replay.test.ts`):

| File | What | Source |
|------|------|--------|
| `literally-2026-q3.probes.jsonl` | 285 captured probe units (every surface, both sections), the probe store of the 2026-09-04 run | `aeo/checkpoints/literally-2026-q3.jsonl` |
| `literally-2026-q3.analysis.jsonl` | 19 search analyses (analyzer v2) + 2 perception extractions (v2), keyed as the analysis store keys them | `aeo/checkpoints/literally-2026-q3.analysis.jsonl` |
| `literally-2026-q3.domain-labels.json` | The learned labels file (classifier v1) the relabel of 2026-09-04 produced | `content/aeo-insights/literally-2026-q3/domain-labels.json` |

The test loads the three files into the in-memory stores, runs
`executeRun` with stubbed technical checks and the committed CLI versions,
mocks the AI SDK to throw, and asserts that the assembled snapshot equals
the committed `snapshot.json` (modulo `meta.migrations`, `meta.runId`,
`meta.models`) and that every published evidence chunk equals its committed
file. Any cache miss — a changed key formula, an invalid cached value, a
host the labels file does not cover — fails the test instead of spending
money.

Lines in the probes file predate unit outcomes and carry no `status`; the
store reads them as captured records. Three Google AI Overview rows hold
the pre-2026-09-06 sentinel text (`[Google did not generate an AI Overview
for this query]`) and were analyzed as answers at the time; new captures
record `noOverview` instead.

When a version constant is deliberately bumped (analyzer, perception,
classifier), the fixture keys carry the old version and the replay misses:
either re-run the report and refresh all three files from the new run, or
keep the fixture on the old version and pin the new behavior in the step's
own tests.
## Reader migration

`literally-2026-q3/` holds the self-audit config, expected snapshot and
evidence chunks used by the golden replay. The replay no longer imports
the live config registry or reads `content/aeo-insights/`, so the eventual
database-reader cleanup cannot remove its inputs. These fixtures contain
Literally.dev's public self-audit, not client baselines or credentials.
