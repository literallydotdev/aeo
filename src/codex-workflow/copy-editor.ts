import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildFactCatalog,
  projectWriterFactCatalog,
  type FactCatalog,
} from '../agents/facts';
import { narrativeContextFactIds } from '../agents/copy-validation';
import {
  premiseVerifierInstructions,
  type VerifierHistory,
} from '../agents/verifier';
import {
  generateStructured,
  structuredCallReservation,
  type StructuredTransport,
} from '../models/structured';
import { contentHash } from '../stores/content-hash';
import type { GroundingBundle } from '../grounding/schema';
import type { ModelCallAccounting } from '../models/accounting';
import type { InternalModelRoleConfig } from '../models/profiles';
import type { AeoAuditConfig, AeoSnapshot } from '../schema';
import { writeOutputSchema, type WriteOutput } from './schemas';
import { copywriterFiles } from './copy';
import { writePendingJson } from './pending';

export type CopyEdit = {
  inputDigest: string;
  draft?: unknown;
  round: number;
  errors: string[];
  editedDraft: WriteOutput;
  /** Context the call gave up to fit the role's input limit, in order. */
  trimmed?: string[];
};

/** Adjacent edits already contain each other's input. Send each version once. */
export const copyEditHistory = (edits: readonly CopyEdit[]) => {
  return edits.map(({ round, errors, editedDraft }) => ({
    round,
    findings: errors,
    editedDraft,
  }));
};

/** Keep every fact the current draft cites; use spare room for alternative
 * measurements and verified product facts the verifier can use in its edit. */
export const copyEditCall = (args: {
  draft: unknown;
  errors: readonly string[];
  edits: readonly CopyEdit[];
  reviewHistory: VerifierHistory;
  catalog: FactCatalog;
  context: unknown;
  rules: Record<string, string>;
  role: InternalModelRoleConfig;
}) => {
  const cited = new Set<string>(narrativeContextFactIds);
  const visit = (value: unknown, key?: string) => {
    if (
      typeof value === 'string' &&
      (key === 'factId' || key === 'basisFactIds')
    ) {
      cited.add(value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([field, entry]) => visit(entry, field));
    }
  };

  visit(args.draft);

  const projected = projectWriterFactCatalog(args.catalog);
  const selected = projected.facts.filter((fact) => cited.has(fact.factId));
  const system = `${premiseVerifierInstructions}\nThis is your editing turn: return only the complete edited draft required by the response schema, not a review object. You own the copy now. Edit the current draft directly to fix the supplied findings and any other concrete issue you notice. Never ask the implementer to revise it. Preserve correct wording and meaning. Keep the hero, single narrative introduction, configured sections and confidence. Your edited text will be reviewed again by this same verifier with its earlier findings and edits retained. Fix factual premises and their basisFactIds together. Do not invent facts to satisfy a finding; narrow or remove unsupported claims. The supplied facts include the current draft's evidence and additional scoped measurements or verified product facts when they fit. Full source passages are checked during your next verification. The supplied rules define voice and shape, not additional evidence.`;
  // What the call carries besides the draft, its findings and its cited
  // facts, in the order it is given up when the whole does not fit the
  // role's input limit: every previous edit carries a full draft, the
  // review history grows a review per block per round, and the rule
  // documents are voice, not evidence. Botpress's copy pass (2026-09-15)
  // refused the edit before any model call because all of it together was
  // over the limit, and the report shipped without a narrative.
  const trims: { name: string; apply: () => void }[] = [
    {
      name: 'older_edits',
      apply: () => {
        edits = edits.slice(-1);
      },
    },
    {
      name: 'all_edits',
      apply: () => {
        edits = [];
      },
    },
    {
      name: 'older_reviews',
      apply: () => {
        reviewHistory = Object.fromEntries(
          Object.entries(reviewHistory).map(([path, history]) => [
            path,
            history.slice(-1),
          ]),
        );
      },
    },
    {
      name: 'all_reviews',
      apply: () => {
        reviewHistory = {};
      },
    },
    {
      name: 'company_rules',
      apply: () => {
        rules = Object.fromEntries(
          Object.entries(rules).filter(
            ([name]) => !name.startsWith('company/'),
          ),
        );
      },
    },
  ];

  let edits = args.edits;
  let reviewHistory = args.reviewHistory;
  let rules = args.rules;
  const trimmed: string[] = [];
  const call = () => {
    return {
      role: args.role,
      schema: writeOutputSchema,
      system,
      prompt: JSON.stringify({
        currentDraft: args.draft,
        findings: args.errors,
        previousReviews: reviewHistory,
        previousEdits: copyEditHistory(edits),
        facts: { ...projected, facts: selected },
        context: args.context,
        rules,
      }),
    };
  };

  // The draft's own evidence and the findings are never given up: a call
  // that cannot carry those is refused, and the report ships on its facts.
  for (const trim of trims) {
    try {
      structuredCallReservation(call());
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'model_input_limit') {
        throw error;
      }

      trim.apply();
      trimmed.push(trim.name);
    }
  }

  structuredCallReservation(call());

  for (const fact of projected.facts) {
    if (
      cited.has(fact.factId) ||
      !['measurement', 'product_fact'].includes(fact.kind)
    ) {
      continue;
    }

    selected.push(fact);

    try {
      structuredCallReservation(call());
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'model_input_limit') {
        throw error;
      }

      selected.pop();
    }
  }

  return { ...call(), trimmed };
};

// The verifier's own edit log, written by editCopyDraft below.
const savedCopyEditsSchema = z
  .object({
    scope: z.string(),
    edits: z.array(
      z.object({
        inputDigest: z.string(),
        draft: z.unknown().optional(),
        round: z.number(),
        errors: z.array(z.string()),
        editedDraft: writeOutputSchema,
        trimmed: z.array(z.string()).optional(),
      }),
    ),
  })
  .nullable();

/** The verifier keeps its edits as well as its findings across replacements. */
export const readCopyEdits = async (
  dir: string,
  scope: string,
): Promise<CopyEdit[]> => {
  const raw = await readFile(
    path.join(dir, 'PENDING/copy-edits.json'),
    'utf8',
  ).catch(() => 'null');

  const saved = savedCopyEditsSchema.parse(JSON.parse(raw));

  return saved?.scope === scope ? saved.edits : [];
};

/** The frozen evidence and the pinned verifier an edit is made with: the
 * same inputs the draft is validated against, with the verifier's role and
 * accounting resolved, because the edit is charged and pinned exactly as
 * the verification is. */
export type CopyEditEvidence = {
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  runId: string;
  grounding: GroundingBundle | null;
  verifierRole: InternalModelRoleConfig;
  accounting: ModelCallAccounting;
  signal?: AbortSignal;
};

/** Editing belongs to the verifier that found the issue. The implementer
 * is never called again after handing over its initial draft. */
export const editCopyDraft = async (args: {
  dir: string;
  scope: string;
  draft: unknown;
  round: number;
  errors: string[];
  reviewHistory: VerifierHistory;
  validation: CopyEditEvidence;
  checkpoint?: (files: readonly string[]) => Promise<void>;
  transport?: StructuredTransport;
}): Promise<WriteOutput> => {
  const edits = await readCopyEdits(args.dir, args.scope);
  const rules = await copywriterFiles();
  const inputDigest = contentHash({
    draft: args.draft,
    round: args.round,
    errors: args.errors,
    rules,
  });

  const previous = edits.find((edit) => edit.inputDigest === inputDigest);

  if (previous) {
    await args.checkpoint?.(['PENDING/copy-edits.json']);

    return previous.editedDraft;
  }

  const {
    config,
    snapshot,
    runId,
    grounding,
    verifierRole,
    accounting,
    signal,
  } = args.validation;

  const catalog = buildFactCatalog({
    snapshot,
    config,
    runId,
    grounding: grounding ?? undefined,
  });

  const { trimmed, ...call } = copyEditCall({
    role: verifierRole,
    draft: args.draft,
    errors: args.errors,
    reviewHistory: args.reviewHistory,
    edits,
    catalog,
    rules,
    context: {
      brand: config.brand,
      sections: config.sections.map((section) => section.key),
    },
  });

  const result = await generateStructured(
    { roleName: 'premiseVerifier', accounting, signal, ...call },
    args.transport,
  );

  const editedDraft = result.output;
  const file = 'PENDING/copy-edits.json';

  await writePendingJson(path.join(args.dir, file), {
    scope: args.scope,
    edits: [
      ...edits,
      {
        inputDigest,
        draft: args.draft,
        round: args.round,
        errors: args.errors,
        editedDraft,
        ...(trimmed.length ? { trimmed } : {}),
      },
    ].slice(-5),
  });
  await args.checkpoint?.([file]);

  return editedDraft;
};
