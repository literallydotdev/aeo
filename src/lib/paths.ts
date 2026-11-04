import path from 'node:path';

// Committed snapshot home — one directory per reportKey, holding
// snapshot.json plus evidence/ chunk files (spec §3).
export const aeoContentDir = path.join(
  process.cwd(),
  'content',
  'aeo-insights',
);

// Run checkpoints — one JSONL file per reportKey holding every captured
// probe, so an interrupted or partially failed run resumes instead of
// re-paying for probes. Gitignored: entries carry raw answer text.
export const aeoCheckpointDir = path.join(process.cwd(), 'aeo', 'checkpoints');
