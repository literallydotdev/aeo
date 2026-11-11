import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '../stores/fs-errors';
import {
  bundlePaths,
  bundleSchemaVersion,
  objectPathPrefix,
  RunOrigin,
  type BundleManifest,
} from './contracts';
import { summarizeIsolation, type RunIsolation } from './isolation';
import { readJournal } from './journal';
import { sha256Hex } from './json';
import { runJournalDir } from './recorder';
import { assessTraceCoverage, type CapturedAnswer } from './trace-coverage';

// ============================================================================
// The run journal as bundle files (specs/aeo-open-source-cli-spec.md §7.3,
// §8): a prefix of JOURNAL/run/events.jsonl, byte for byte, and every
// object those events reference. A work directory without a journal is a
// historical artifact: it exports an empty trace and says so.
// ============================================================================

// What a complete journal still cannot show: the visibility each adapter
// declares, stated so "declared" is never read as "everything".
const declaredTraceLimitations = [
  'Codex stage sessions and coding-agent probes are recorded as CLI sessions (instructions, event stream or answer, session usage), not as the provider requests inside them.',
  'Chat probes record the prompt the host sent and the answer, retrieval log and served model the gateway reported; provider-side instructions and routing are not visible.',
  'Research fetches record the passages grounding read and the number of HTTP requests, not raw page bodies. Technical checks are one operation per check with its parameters and extracted result; their individual requests are not retained.',
];

// A journal whose writers did not observe every operation kind: the hosted
// job, or a run directory begun before capture was recorded.
const partialTraceLimitations = [
  "Host model calls of the workflow (perception, source labels, the copy verifier, grounding's extraction, research decisions and adjudication) carry their exact request and response; review corrections are recorded as host decisions.",
  'An output reused from before the journal began appears as artifact_reused without the session that produced it.',
];

const legacyTraceLimitations = [
  'No host execution journal was recorded for this run: operations, model requests, retries and their timings are not in the bundle.',
];

const runtimeSchema = z.looseObject({
  tool: z.string(),
  version: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
});

const originSchema = z.enum([
  RunOrigin.LOCAL,
  RunOrigin.HOSTED,
  RunOrigin.LEGACY_IMPORT,
]);

export type JournalProjection = {
  files: Map<string, Buffer>;
  events: BundleManifest['events'];
  /** Events in the run journal, beyond the exported prefix included. */
  journalLength: number;
  origin: RunOrigin;
  trace: BundleManifest['trace'];
  writers: z.infer<typeof runtimeSchema>[];
  isolation: RunIsolation;
};

/**
 * projectJournal reads the run journal of a work directory, up to
 * `eventLimit` events when given. A damaged journal or a missing object
 * refuses the export: delivering it would look like a complete trace.
 */
export const projectJournal = async (
  dir: string,
  {
    eventLimit,
    captured = [],
    derived = false,
  }: {
    eventLimit?: number;
    /** The bundle's captured answers, checked against probe operations. */
    captured?: readonly CapturedAnswer[];
    derived?: boolean;
  } = {},
): Promise<JournalProjection> => {
  const root = path.join(dir, runJournalDir);
  const text = await readFile(path.join(root, 'events.jsonl'), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  if (text === undefined) {
    return {
      files: new Map([[bundlePaths.events, Buffer.alloc(0)]]),
      events: { count: 0, head: null },
      journalLength: 0,
      origin: RunOrigin.LEGACY_IMPORT,
      trace: { coverage: 'none', limitations: legacyTraceLimitations },
      writers: [],
      isolation: summarizeIsolation([]),
    };
  }

  const reading = readJournal(text);

  if (reading.errors.length > 0) {
    throw new Error(
      `The run journal of ${dir} is damaged and cannot be exported: ${reading.errors.join(' ')}`,
    );
  }

  const count = Math.min(
    eventLimit ?? reading.events.length,
    reading.events.length,
  );
  const events = reading.events.slice(0, count);
  // The exact bytes the writer appended: a re-serialized line could differ.
  const lines = text.split('\n').slice(0, count);
  const files = new Map<string, Buffer>([
    [
      bundlePaths.events,
      Buffer.from(lines.map((line) => `${line}\n`).join('')),
    ],
  ]);

  for (const digest of new Set(events.flatMap((event) => event.objects))) {
    const target = `${objectPathPrefix}${digest}`;
    const bytes = await readFile(path.join(root, target));

    if (sha256Hex(bytes) !== digest) {
      throw new Error(
        `The run journal object ${target} in ${dir} does not hold its digested bytes.`,
      );
    }

    files.set(target, bytes);
  }

  const started = events.find((event) => event.type === 'run_started');
  const origin = originSchema.safeParse(started?.payload.origin);
  const writers = events
    .filter(
      (event) => event.type === 'run_started' || event.type === 'run_resumed',
    )
    .flatMap((event) => {
      const runtime = runtimeSchema.safeParse(event.payload.runtime);

      return runtime.success ? [runtime.data] : [];
    });

  const coverage = assessTraceCoverage({
    events,
    captured,
    derived,
    bundleSchema: bundleSchemaVersion,
  });
  const trace: BundleManifest['trace'] =
    coverage.gaps.length === 0
      ? {
          coverage: 'declared',
          limitations: [...coverage.notes, ...declaredTraceLimitations],
        }
      : {
          coverage: 'partial',
          limitations: [
            ...coverage.gaps,
            ...coverage.notes,
            ...partialTraceLimitations,
          ],
        };

  const projection: JournalProjection = {
    files,
    events: { count, head: events.at(-1)?.digest ?? null },
    journalLength: reading.events.length,
    origin: origin.success ? origin.data : RunOrigin.LEGACY_IMPORT,
    trace,
    writers,
    isolation: summarizeIsolation(events),
  };

  return projection;
};
