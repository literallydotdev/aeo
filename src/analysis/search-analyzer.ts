import { APICallError } from 'ai';
import type { AeoBrand } from '../schema';
import { ModelBudgetError } from '../models/accounting';
import { ModelCallAbortError } from '../models/errors';
import { normalizedBrandName } from './name-forms';
import { normalizeDomain } from './scoring';

// ============================================================================
// What remains of the in-process search analyzer. The Codex workflow's
// analyze stage (src/codex-workflow/) judges the captured answers now; this
// module keeps only what the live pipeline still reads:
//  - the retry classification the perception pass shares (sentiment.ts);
//  - the prospect-mention reconciliation the Codex checks apply to every
//    analyzed row (codex-workflow/checks.ts).
// ============================================================================

/**
 * isRetryable tells whether a failed model call is worth another attempt.
 * Budget and host aborts are final, as are the input and output limits; client
 * errors will not fix themselves, while a gateway or provider outage may.
 */
export const isRetryable = (error: unknown): boolean => {
  if (
    error instanceof ModelBudgetError ||
    error instanceof ModelCallAbortError ||
    (error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.startsWith('model_input_limit') ||
        error.message === 'model_output_limit'))
  ) {
    return false;
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;

    // Client errors (bad key, invalid request) will not fix themselves.
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  return true;
};

/**
 * reconcileProspectMentions reconciles the prospect mention. An answer the
 * analyzer judged not to mention the measured product cannot also list that
 * product among its mentioned brands: the two fields are one judgment. The
 * model kept "Deno" in the brand list of an answer about Netlify's Deno-based
 * edge functions while (correctly) marking the prospect absent, and the
 * reviewer refused the row (run A, 2026-09-13). The prospect's own entries are
 * dropped; every other brand stays.
 */
export const reconcileProspectMentions = <
  T extends {
    clientMentioned: boolean;
    allMentionedBrands: { name: string; domain: string | null }[];
  },
>(
  analyzed: T,
  brand: AeoBrand,
): T => {
  if (analyzed.clientMentioned) {
    return analyzed;
  }

  const names = [brand.name, ...brand.aliases].map(normalizedBrandName);
  const domain = normalizeDomain(brand.domain);
  const isProspect = (entry: { name: string; domain: string | null }) => {
    const name = normalizedBrandName(entry.name);

    return (
      names.some((known) => name === known || name.startsWith(`${known} `)) ||
      (entry.domain !== null && normalizeDomain(entry.domain) === domain)
    );
  };

  return {
    ...analyzed,
    allMentionedBrands: analyzed.allMentionedBrands.filter(
      (entry) => !isProspect(entry),
    ),
  };
};
