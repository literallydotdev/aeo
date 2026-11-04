import { z } from 'zod';
import type { PublicationTriple } from './publication';

export const publishedHistoryLimit = 50;

export const publicationTripleSchema = z.object({
  reportKey: z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/),
  configVersion: z.number().int().positive(),
  copyVersion: z.number().int().positive(),
});

export type PublicationHistoryEntry = {
  firstPublishedAt: string | null;
  recordedAt: string;
  origin: 'publication' | 'backfill' | 'legacy_import';
} & PublicationTriple;

type DatedPublication = {
  firstPublishedAt: Date | string | null;
  origin: PublicationHistoryEntry['origin'];
  // The run snapshot's meta.generatedAt; read only for an undated row.
  reportGeneratedAt: string | null;
};

/**
 * publicationDate is when a ledger row's report went public. The 0006 backfill
 * and legacy imports recorded no date, and the ledger is append-only. Those
 * reports were published as they were generated, so the run snapshot's date
 * stands in. Capture dates are never inferred from it.
 */
export const publicationDate = ({
  firstPublishedAt,
  origin,
  reportGeneratedAt,
}: DatedPublication): string | null => {
  const instant =
    firstPublishedAt ?? (origin === 'publication' ? null : reportGeneratedAt);

  if (instant === null) {
    return null;
  }

  const time =
    instant instanceof Date ? instant.getTime() : Date.parse(instant);

  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
