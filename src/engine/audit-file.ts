import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  SourceRetrievalError,
  validateResearchUrl,
} from '../grounding/guarded-request';
import type { ModelBudgetLimits } from '../models/accounting';
import { localModelProfile } from '../models/local-profile';
import { resolveSupportedModel } from '../models/supported-models';
import { resolveDataForSeoLocale } from '../probes/dataforseo-locale';
import { probeLimitsSchema } from '../probes/limits';
import { urlIsOnDomain } from '../report/core/domain-match';
import {
  aeoAuditConfigSchema,
  aeoSurfaceSchema,
  agentProbeConfigSchema,
  allSurfaces,
  brandSchema,
  chatProbeConfigSchema,
  coverageThresholdsSchema,
  defaultMaxPlannedUnits,
  isAgentSurface,
  runRequestSchema,
  type AeoAuditConfig,
  type RunRequest,
} from '../schema';
import { budgetPolicySchema } from './budget';

// ============================================================================
// audit.json, the configuration a customer writes
// (specs/aeo-open-source-cli-spec.md §4.1): what is measured, kept apart from
// the run policy that only limits how. Nothing here names a report key, a
// database version or a Batch field; the engine derives the internal
// identities it needs from the brand.
// ============================================================================

export const auditFileVersion = 1;

export const authorRecordFile = 'author-record.json';

/** What audit.json says about the session that proposed it. */
export const authorReferenceSchema = z
  .object({
    runId: z.string().min(1),
    proposedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    record: z.literal(authorRecordFile),
  })
  .strict();

export type AuthorReference = z.infer<typeof authorReferenceSchema>;

const keyPattern = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

const promptSchema = z
  .object({
    id: z.string().regex(keyPattern, 'Use lowercase letters, digits, _ or -'),
    text: z.string().trim().min(1),
    category: z
      .enum([
        'product_recommendation',
        'industry_expert',
        'comparison',
        'problem_solving',
        'general_knowledge',
      ])
      .default('product_recommendation'),
  })
  .strict();

const sectionSchema = z
  .object({
    key: z.string().regex(keyPattern, 'Use lowercase letters, digits, _ or -'),
    prompts: z.array(promptSchema).min(1),
    // A section that measures a different market than the report as a whole.
    competitors: z.array(brandSchema).min(1).optional(),
  })
  .strict();

/** The run policy: limits on spend and pace, never measurement inputs. */
export const runPolicySchema = z
  .object({
    maxPlannedUnits: z
      .number()
      .int()
      .positive()
      .default(defaultMaxPlannedUnits),
    limits: probeLimitsSchema.prefault({}),
    coverageThresholds: coverageThresholdsSchema.prefault({}),
    allowPartial: z.boolean().default(false),
    // Caps every paid call of the run: probes, Codex stage sessions, host
    // model calls and searches (see BudgetPolicy).
    budget: budgetPolicySchema.prefault({}),
    // Hosts off the brand's site whose pages the site checks may fetch (a
    // docs site on another domain). A permission, not a measurement input:
    // granting one never moves a baseline.
    checkHosts: z.array(z.string().trim().min(1)).max(20).default([]),
  })
  .strict();

/** Why a checkHosts entry is refused: it must be a bare public host name. */
const checkHostProblem = (host: string): string | undefined => {
  try {
    const url = validateResearchUrl(`https://${host}/`);

    if (url.hostname === host.toLowerCase()) {
      return undefined;
    }
  } catch (err) {
    if (!(err instanceof SourceRetrievalError)) {
      throw err;
    }
  }

  return `Use a bare public host name such as docs.acme.example, not ${JSON.stringify(host)}.`;
};

/**
 * Why a money page is refused. The site checks fetch and render it, so it
 * must be public https on the brand's site or its subdomains, or on a host
 * the operator named in runPolicy.checkHosts.
 */
const moneyPageProblem = (
  page: string,
  file: {
    brand: { domain: string };
    runPolicy: { checkHosts: readonly string[] };
  },
): string | undefined => {
  try {
    validateResearchUrl(page);
  } catch (err) {
    if (err instanceof SourceRetrievalError) {
      return `A money page must be a public https URL with no port or credentials: ${err.message}`;
    }

    throw err;
  }

  const hosts = [file.brand.domain, ...file.runPolicy.checkHosts];

  if (hosts.some((host) => urlIsOnDomain(page, host))) {
    return undefined;
  }

  return `${page} is not on ${file.brand.domain} or its subdomains. Name its host in runPolicy.checkHosts to let the site checks fetch it.`;
};

export const auditFileSchema = z
  .object({
    version: z.literal(auditFileVersion),
    // The gateway model every text role and Codex stage runs on; absent
    // means the engine's recommended model (src/models/supported-models.ts).
    // Probe surfaces are what is measured and keep their own pinned models.
    model: z.string().trim().min(1).optional(),
    brand: brandSchema,
    competitors: z.array(brandSchema).min(1),
    ownedDomains: z.array(z.string().min(1)).max(20).optional(),
    sections: z.array(sectionSchema).min(1).max(2),
    surfaces: z
      .array(aeoSurfaceSchema)
      .min(1)
      .default([...allSurfaces]),
    // Strict here, unlike the internal config that bundles keep: a
    // misspelled key is refused, never dropped for the default depth.
    agentProbes: agentProbeConfigSchema.strict().prefault({}),
    // Absent = the standard depth (2 runs per prompt, 1 on AI Overview).
    chatProbes: chatProbeConfigSchema.optional(),
    geography: z.string().default('us'),
    language: z.string().default('en'),
    moneyPages: z.array(z.url()).max(20).default([]),
    productBrief: z.string().trim().min(1),
    // `full` researches and adjudicates the claims answers make about the
    // product; `extraction_only` keeps the claim inventory and skips both.
    grounding: z.enum(['full', 'extraction_only']).default('full'),
    runPolicy: runPolicySchema.prefault({}),
    // Written by `literally-aeo author`; absent from a hand-written config.
    author: authorReferenceSchema.optional(),
  })
  .strict()
  .superRefine((file, context) => {
    // Never a silent fallback to the US: AI Overviews and grounding search
    // are placed in this market or the config is refused.
    if (!resolveDataForSeoLocale(file.geography, file.language)) {
      context.addIssue({
        code: 'custom',
        message: `No search market for geography ${JSON.stringify(file.geography)} and language ${JSON.stringify(file.language)}; use a supported code such as us and en.`,
        path: ['geography'],
      });
    }

    for (const [index, host] of file.runPolicy.checkHosts.entries()) {
      const problem = checkHostProblem(host);

      if (problem !== undefined) {
        context.addIssue({
          code: 'custom',
          message: problem,
          path: ['runPolicy', 'checkHosts', index],
        });
      }
    }

    for (const [index, page] of file.moneyPages.entries()) {
      const problem = moneyPageProblem(page, file);

      if (problem !== undefined) {
        context.addIssue({
          code: 'custom',
          message: problem,
          path: ['moneyPages', index],
        });
      }
    }

    const keys = file.sections.map((section) => section.key);

    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Section keys must be unique.',
        path: ['sections'],
      });
    }

    for (const [index, section] of file.sections.entries()) {
      const ids = section.prompts.map((prompt) => prompt.id);

      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          message: 'Prompt ids must be unique within a section.',
          path: ['sections', index, 'prompts'],
        });
      }
    }
  });

export type AuditFile = z.infer<typeof auditFileSchema>;

/** readAuditFile reads and validates audit.json, naming what is wrong. */
export const readAuditFile = async (file: string): Promise<AuditFile> => {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    throw new Error(`Please check --config: ${file} cannot be read.`, {
      cause: err,
    });
  });

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON.`, { cause: err });
  }

  const parsed = auditFileSchema.safeParse(value);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );

    throw new Error(
      [`${file} is not a valid audit configuration:`, ...issues].join('\n'),
    );
  }

  return parsed.data;
};

/** The internal report key a local run uses for its stores and files:
 * derived from the brand, never typed by the customer. */
export const localReportKey = (file: AuditFile): string => {
  const slug = file.brand.domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `local-${slug || 'audit'}`;
};

/** toAuditConfig maps audit.json onto the engine's internal config. */
export const toAuditConfig = (file: AuditFile): AeoAuditConfig => {
  const reportKey = localReportKey(file);
  const measuresAgents = file.surfaces.some(isAgentSurface);

  const config = aeoAuditConfigSchema.parse({
    reportKey,
    slug: reportKey,
    brand: file.brand,
    competitors: file.competitors,
    ...(file.ownedDomains && {
      competitorQualification: { ownedDomains: file.ownedDomains },
    }),
    sections: file.sections,
    agentProbes: file.agentProbes,
    ...(file.chatProbes !== undefined && { chatProbes: file.chatProbes }),
    moneyPages: file.moneyPages,
    productBrief: file.productBrief,
    surfaces: {
      codingAgents: measuresAgents ? 'measure' : 'skip',
      because: 'Selected by the operator in audit.json.',
    },
    geography: file.geography,
    language: file.language,
  });

  return config;
};

/** toRunRequest is the request a local run executes under; the budget is
 * the run's frozen one (resolveRunBudget), absent only for a plan. */
export const toRunRequest = (
  file: AuditFile,
  runId: string,
  modelBudget?: ModelBudgetLimits,
): RunRequest => {
  const request = runRequestSchema.parse({
    reportKey: localReportKey(file),
    runId,
    mode: 'resume',
    grounding: file.grounding,
    modelProfile: localModelProfile(resolveSupportedModel(file.model), {
      // Pinned by the audit, never inferred from which credentials happen to
      // be set: full grounding searches, and preflight requires its key.
      searchProvider:
        file.grounding === 'full' ? 'dataforseo-google-organic-v1' : 'disabled',
    }),
    ...(modelBudget && { modelBudget }),
    surfaces: file.surfaces,
    maxPlannedUnits: file.runPolicy.maxPlannedUnits,
    limits: file.runPolicy.limits,
    coverageThresholds: file.runPolicy.coverageThresholds,
    allowPartial: file.runPolicy.allowPartial,
  });

  return request;
};
