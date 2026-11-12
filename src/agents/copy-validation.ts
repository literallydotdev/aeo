import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json';
import banlist from '../author/banlist.json';
import {
  aeoAuditConfigSchema,
  type AeoAuditConfig,
  type AeoSnapshot,
} from '../schema';
import type { GroundingBundle } from '../grounding/schema';
import { validateGroundingBundle } from '../grounding/validation';
import {
  internalModelRoleDigest,
  type InternalModelRoleConfig,
} from '../models/profiles';
import { ModelBudgetError } from '../models/accounting';
import { ModelCallAbortError } from '../models/errors';
import { structuredFailureDiagnostic } from '../models/failure-diagnostics';
import { isRecord } from '../lib/type-guards';
import { credentialDetected } from './credentials';
import {
  buildFactCatalog,
  factCatalogVersion,
  factFingerprint,
  methodologyNote,
  type ReportFact,
} from './facts';
import {
  aeoAgentCopyDraftSchema,
  aeoReportCopySchema,
  pendingReportCopy,
  type AeoAgentCopyDraft,
  type AeoReportCopy,
  type CopyBlock,
} from './copy-schema';

// 8: receipts issued under premise verifier prompt 4. A receipt names its
// checker, and the checker names the verifier prompt it was issued under
// (assertCopyValidation), so a new verifier prompt is a new checker: 0.4.1
// moved the prompt and left this at 7, which read every earlier receipt as
// issued under the new prompt and refused it.
export const copyCheckerVersion = 8;
// 4: the verifier refuses a comparison of two rates or counts
// (unsupported_rate_comparison).
export const premiseVerifierPromptVersion = 4;

/** Host framing every narrative block rests on whether or not the writer
 * declares it: the report identity and publisher, the captured surfaces,
 * the mention/citation definitions and the capture count. Verification
 * supplies them with every narrative block; the verifier's editing turn
 * keeps them in reach. */
export const narrativeContextFactIds = [
  'scope:report',
  'scope:surfaces',
  'scope:mentions-citations',
  'aggregate:captured',
] as const;

export type CopyValidationError = {
  code: string;
  path: string;
  message: string;
};

/** Distinguishable outcomes (orchestrator spec §7.3): a writer is asked to
 * revise only for `invalid_copy`; every other outcome retries verification of
 * the same draft, blocks, or stops. */
export type CopyValidationOutcome =
  | 'valid'
  | 'invalid_copy'
  | 'invalid_review'
  | 'verifier_unavailable'
  | 'budget_exhausted'
  | 'cancelled'
  | 'integrity_error';

export type VerifierFailureOutcome = Exclude<
  CopyValidationOutcome,
  'valid' | 'invalid_copy'
>;

type InvalidReviewReason =
  'unreviewed_blocks' | 'duplicate_verdict' | 'inconsistent_verdict';

const describeInvalidReview = (
  reason: InvalidReviewReason,
  blockCount: number,
) => {
  switch (reason) {
    case 'unreviewed_blocks': {
      return `Semantic verification returned no verdict for ${blockCount} block(s) after repeated requests`;
    }
    case 'duplicate_verdict': {
      return 'Semantic verification returned more than one verdict for a block';
    }
    case 'inconsistent_verdict': {
      return `Semantic verification returned a verdict that contradicts its own findings or skipped a declared premise for ${blockCount} block(s)`;
    }
    default: {
      const unhandled: never = reason;

      throw new Error(`Unhandled invalid review reason: ${String(unhandled)}.`);
    }
  }
};

/** The verifier answered, but not with a verdict the host can act on: a
 * block left without one even after asking again, two verdicts for one
 * block, a verdict that contradicts its own premise findings, or a declared
 * premise it skipped. That is a failed review of an unchanged draft
 * (`invalid_review`), never a finding against the copy: only block paths
 * travel with it, no prose. */
export class InvalidReviewError extends Error {
  readonly reason: InvalidReviewReason;
  readonly paths: readonly string[];
  /** Host-written rule names per block, never provider text. */
  readonly details: readonly string[];

  constructor(
    reason: InvalidReviewReason,
    paths: readonly string[],
    details: readonly string[] = [],
  ) {
    super(describeInvalidReview(reason, paths.length));

    this.name = 'InvalidReviewError';
    this.reason = reason;
    this.paths = paths;
    this.details = details;
  }
}

/**
 * classifyVerifierFailure maps an error to an outcome. Only allowlisted labels
 * leave the error; no provider body or prompt text.
 */
export const classifyVerifierFailure = (
  error: unknown,
  signal?: AbortSignal,
): VerifierFailureOutcome => {
  if (signal?.aborted && !(error instanceof ModelCallAbortError)) {
    return 'cancelled';
  }

  if (error instanceof ModelCallAbortError) {
    return error.reason === 'cancelled' ? 'cancelled' : 'verifier_unavailable';
  }

  if (error instanceof ModelBudgetError) {
    return error.kind === 'exhausted' || error.kind === 'deadline'
      ? 'budget_exhausted'
      : 'integrity_error';
  }

  if (error instanceof InvalidReviewError) {
    return 'invalid_review';
  }

  if (error instanceof Error) {
    if (error.message === 'model_input_limit') {
      return 'invalid_review';
    }

    if (error.message === 'model_output_limit') {
      return 'invalid_review';
    }

    if (error.name === 'ZodError') {
      return 'invalid_review';
    }
  }

  const diagnostic = structuredFailureDiagnostic(error, signal);

  if (diagnostic.classification === 'schema') {
    return 'invalid_review';
  }

  if (diagnostic.classification === 'outputlimit') {
    return 'invalid_review';
  }

  if (diagnostic.classification === 'abort') {
    return 'cancelled';
  }

  return 'verifier_unavailable';
};

const verifierFailureCodes: Record<VerifierFailureOutcome, string> = {
  invalid_review: 'premise_verifier_invalid',
  verifier_unavailable: 'premise_verifier_unavailable',
  budget_exhausted: 'model_budget_exhausted',
  cancelled: 'cancelled',
  integrity_error: 'integrity_error',
};

export type RecommendationInput = {
  text: string;
  kind: 'recommendation' | 'narrative' | 'human_copy';
  intendedAction: string | null;
  premises: { proposition: string; basisFactIds: string[] }[];
  facts: ReportFact[];
  path: string;
};

export type RecommendationVerifier = (
  recommendations: RecommendationInput[],
  signal?: AbortSignal,
) => Promise<{
  valid: boolean;
  errors: string[];
  issues?: CopyValidationError[];
  model: string;
  basisFactIds?: string[];
}>;

type CopyDependencies = {
  catalogVersion: number;
  groundingDigest: string | null;
  sourceBundleDigest: string | null;
  assessmentDigests: Record<string, string>;
  verifierProfileDigest: string;
  verifierPromptVersion: number;
};

export type AgentCopyProvenance = {
  kind: 'agent';
  runId: string;
  draft: AeoAgentCopyDraft;
  factFingerprints: Record<string, string>;
} & CopyDependencies;

export type HumanCopyProvenance = {
  kind: 'human';
  runId: string;
  factFingerprints: Record<string, string>;
} & CopyDependencies;

export type CopyProvenance = AgentCopyProvenance | HumanCopyProvenance;

export type CopyValidationReceipt = {
  checkerVersion: number;
  runId: string;
  reportKey: string;
  configVersion: number | null;
  configDigest: string;
  digest: string;
  verifierModel: string;
  verifierProfile: InternalModelRoleConfig;
  validatedAt: string;
} & CopyDependencies;

export type CopyValidationResult = {
  valid: boolean;
  errors: CopyValidationError[];
  outcome: CopyValidationOutcome;
  copy?: AeoReportCopy;
  provenance?: AgentCopyProvenance;
  receipt?: CopyValidationReceipt;
};

export const validateAgentCopy = async (args: {
  draft: unknown;
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  runId: string;
  configVersion?: number;
  grounding?: GroundingBundle;
  verifierProfile: InternalModelRoleConfig;
  verifier: RecommendationVerifier;
  previous?: AeoReportCopy | null;
  brandLogo?: AeoReportCopy['brandLogo'];
  secrets?: readonly string[];
  signal?: AbortSignal;
}): Promise<CopyValidationResult> => {
  const errors: CopyValidationError[] = [];
  const fail = (code: string, path: string, message: string) => {
    errors.push({ code, path, message });
  };

  if (credentialDetected(JSON.stringify(args.draft), args.secrets)) {
    return {
      valid: false,
      outcome: 'invalid_copy',
      errors: [
        {
          code: 'credential_detected',
          path: '',
          message: 'Credential-shaped output is forbidden',
        },
      ],
    };
  }

  const parsed = aeoAgentCopyDraftSchema.safeParse(args.draft);

  if (!parsed.success) {
    return {
      valid: false,
      outcome: 'invalid_copy',
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema_invalid',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const draft = parsed.data;

  if (draft.hero && !draft.intro.some((block) => block.kind === 'narrative')) {
    return {
      valid: false,
      outcome: 'invalid_copy',
      errors: [
        {
          code: 'narrative_format_invalid',
          path: 'hero',
          message: 'The final opening requires a completed insight narrative',
        },
      ],
    };
  }

  const hasSectionCopy = Object.values(draft.sections).some(
    (section) =>
      section.subtitle.length > 0 ||
      (section.perceptionCopy?.length ?? 0) > 0 ||
      (section.retrievalCopy?.length ?? 0) > 0,
  );

  if (
    draft.intro.some((block) => block.kind === 'narrative') &&
    (draft.intro.length !== 1 ||
      (draft.actionPlan?.length ?? 0) > 0 ||
      hasSectionCopy)
  ) {
    return {
      valid: false,
      outcome: 'invalid_copy',
      errors: [
        {
          code: 'narrative_format_invalid',
          path: 'intro',
          message:
            'Write one concise introduction; tables own the section measurements and action plans are not requested',
        },
      ],
    };
  }

  const profile = args.verifierProfile;
  let catalog;

  try {
    if (args.grounding) {
      validateGroundingBundle(args.grounding, {
        reportKey: args.config.reportKey,
        runId: args.runId,
        configVersion: args.configVersion,
      });
    }

    catalog = buildFactCatalog({
      snapshot: args.snapshot,
      config: args.config,
      runId: args.runId,
      grounding: args.grounding,
    });
  } catch {
    return {
      valid: false,
      outcome: 'integrity_error',
      errors: [
        {
          code: 'grounding_invalid',
          path: 'grounding',
          message: 'Grounding does not match the immutable run and config',
        },
      ],
    };
  }

  const facts = new Map(catalog.facts.map((fact) => [fact.factId, fact]));
  const used = new Map<string, ReportFact>();
  const recommendations: RecommendationInput[] = [];
  const sectionKeys = new Set(
    args.config.sections.map((section) => section.key),
  );

  for (const key of sectionKeys) {
    if (!Object.hasOwn(draft.sections, key)) {
      fail(
        'section_missing',
        `sections.${key}`,
        'Every configured section needs copy',
      );
    }
  }

  for (const key of Object.keys(draft.sections)) {
    if (!sectionKeys.has(key)) {
      fail('section_missing', `sections.${key}`, 'Unknown section');
    }
  }

  const select = (id: string, section: string | null, path: string) => {
    const fact = facts.get(id);

    if (
      !fact ||
      (section !== null &&
        (fact.kind === 'assessment' || fact.kind === 'observed_claim'
          ? !fact.candidate.occurrences.some(
              (occurrence) => occurrence.section === section,
            )
          : fact.section !== section && fact.section !== null))
    ) {
      fail(
        'fact_reference_invalid',
        path,
        `Unknown or out-of-scope fact: ${id}`,
      );

      return null;
    }

    used.set(id, fact);

    return fact;
  };
  const compile = (
    blocks: CopyBlock[],
    section: string | null,
    path: string,
  ): string => {
    return blocks
      .map((block, index) => {
        const location = `${path}.${index}`;

        if (block.kind === 'fact') {
          return select(block.factId, section, location)?.sentence ?? '';
        }

        if (block.kind === 'assessment') {
          return (
            select(`assessment:${block.assessmentId}`, section, location)
              ?.sentence ?? ''
          );
        }

        if (
          block.kind === 'narrative' &&
          !['intro', 'hero.title', 'hero.subtitle'].includes(path)
        ) {
          fail(
            'narrative_location_invalid',
            location,
            'Narrative belongs in the report introduction or final opening',
          );
        }

        // A premise already declares its basis; a block that cites it only
        // in the premise is complete, not wrong. The verifier sees the union.
        const basisIds = new Set([
          ...block.basisFactIds,
          ...block.premises.flatMap((premise) => premise.basisFactIds),
          // The host knows the report's framing even when the writer uses
          // it implicitly instead of as a declared premise.
          ...(block.kind === 'narrative' ? narrativeContextFactIds : []),
        ]);
        const bases = [...basisIds]
          .map((id) => select(id, section, location))
          .filter((fact): fact is ReportFact => fact !== null);
        const text = block.text;

        if (
          block.kind === 'recommendation' &&
          !/^(?:Consider|Review|Test|Create|Add|Update|Check|Compare|Improve|Explore|Document|Publish|Clarify|Measure|Investigate|Verify|Develop|Build|Try)\b/.test(
            text,
          )
        ) {
          fail(
            'unverified_claim_asserted',
            location,
            'Recommendations must describe proposed work',
          );
        }

        if (
          block.kind === 'recommendation' &&
          /\d|\b(?:percent|percentage|twice|double|half|first|best|worst|leading|higher|lower|more than|less than|most|least|outperform|false|incorrect|wrong|proven|guarantee)\b|["“”]/i.test(
            text,
          )
        ) {
          fail(
            'unverified_claim_asserted',
            location,
            'Recommendations cannot assert measurements, rankings, quotations, or proven errors',
          );
        }

        if (
          /(?:ignore|override|disregard).{0,40}(?:instruction|rule|prompt)|(?:system|developer)\s*(?:message|prompt)|(?:reveal|print|send).{0,30}(?:secret|token|credential)/i.test(
            text,
          )
        ) {
          fail(
            'snapshot_instruction_detected',
            location,
            'Instructions in source material cannot enter copy',
          );
        }

        const lower = text.toLowerCase();

        if (
          banlist.phrases.some((phrase) => lower.includes(phrase)) ||
          banlist.characters.some((character) => text.includes(character))
        ) {
          fail(
            'voice_rule_violation',
            location,
            'Rewrite the flagged stock phrase or punctuation',
          );
        }

        recommendations.push({
          text,
          kind: block.kind,
          intendedAction:
            block.kind === 'recommendation' ? block.intendedAction : null,
          premises: block.premises,
          facts: bases,
          path: location,
        });

        return text;
      })
      .join(' ');
  };
  const copy = pendingReportCopy(args.config);
  copy.intro = compile(draft.intro, null, 'intro');

  if (
    draft.intro.some((block) => block.kind === 'narrative') &&
    !copy.intro.toLowerCase().includes(args.config.brand.name.toLowerCase())
  ) {
    fail('intro_not_specific', 'intro', 'Name the company in its introduction');
  }

  if (draft.hero) {
    const pendingTitle = copy.title;
    copy.title = compile([draft.hero.title], null, 'hero.title');
    copy.subtitle = compile([draft.hero.subtitle], null, 'hero.subtitle');
    copy.metaDescription = copy.subtitle;

    if (
      !copy.title
        .toLowerCase()
        .includes(args.config.brand.name.toLowerCase()) ||
      copy.title.toLowerCase() === pendingTitle.toLowerCase()
    ) {
      fail(
        'hero_not_specific',
        'hero.title',
        'Name the company and frame its measured market in the headline',
      );
    }
  }

  for (const [key, section] of Object.entries(draft.sections)) {
    if (!copy.sections[key]) {
      continue;
    }

    copy.sections[key].subtitle = compile(
      section.subtitle,
      key,
      `sections.${key}.subtitle`,
    );

    if (section.perceptionCopy) {
      copy.sections[key].perceptionCopy = compile(
        section.perceptionCopy,
        key,
        `sections.${key}.perceptionCopy`,
      );
    }

    if (section.retrievalCopy) {
      copy.sections[key].retrievalCopy = compile(
        section.retrievalCopy,
        key,
        `sections.${key}.retrievalCopy`,
      );
    }
  }

  if (draft.actionPlan?.length) {
    copy.actionPlan = {
      heading: 'What to work on next',
      intro: 'Proposed work based on this audit.',
      items: draft.actionPlan.map((item, index) => ({
        title: `Suggested action ${index + 1}`,
        body: compile(item.body, null, `actionPlan.${index}.body`),
      })),
    };
  }

  copy.methodologyNote = methodologyNote(args.snapshot);
  copy.footerNote =
    'This report records the answers captured during this audit. AI answers can change.';
  const brandLogo = args.previous?.brandLogo ?? args.brandLogo;

  if (brandLogo) {
    copy.brandLogo = brandLogo;
  }

  if (args.previous?.heroEyebrow) {
    copy.heroEyebrow = args.previous.heroEyebrow;
  }

  const checked = aeoReportCopySchema.safeParse(copy);

  if (!checked.success) {
    checked.error.issues.forEach((issue) =>
      fail('schema_invalid', issue.path.join('.'), issue.message),
    );
  }

  if (errors.length) {
    return { valid: false, outcome: 'invalid_copy', errors };
  }

  let verifierModel = 'no-recommendations';

  if (recommendations.length) {
    let result: Awaited<ReturnType<RecommendationVerifier>>;

    try {
      result = await args.verifier(recommendations, args.signal);
    } catch (error) {
      // The draft is unchanged and retained. Only the verifier is retried;
      // an unavailable verifier never asks the writer for another draft.
      const outcome = classifyVerifierFailure(error, args.signal);
      // The reason and the block paths are the whole diagnostic: without
      // them an operator sees only that a review was refused (2026-09-12).
      // Block paths carry no prose; nothing from the provider is copied.
      const detail =
        error instanceof InvalidReviewError
          ? ` (${error.reason}: ${(error.details.length ? error.details : error.paths).join('; ')})`
          : '';

      return {
        valid: false,
        outcome,
        errors: [
          {
            code: verifierFailureCodes[outcome],
            path: 'recommendations',
            // Compact, rule first: the journal stores a bounded message and
            // the rule name is what an operator needs from it.
            message:
              outcome === 'invalid_review'
                ? `invalid review${detail}`
                : 'Semantic verification was unavailable',
          },
        ],
      };
    }

    verifierModel = result.model;

    if (
      typeof result.model !== 'string' ||
      !result.model.trim() ||
      (args.grounding && result.model !== profile.model) ||
      !Array.isArray(result.errors)
    ) {
      return {
        valid: false,
        outcome: 'invalid_review',
        errors: [
          {
            code: 'premise_verifier_invalid',
            path: 'recommendations',
            message: 'Semantic verification did not use the pinned verifier',
          },
        ],
      };
    }

    if (result.valid !== true || result.errors.length !== 0) {
      const reasons = result.errors.join('; ');

      fail(
        'claim_not_in_snapshot',
        'recommendations',
        reasons === '' ? 'Verifier rejected the recommendations' : reasons,
      );

      // Structured issue details give the writer exact locations to repair.
      for (const issue of (result.issues ?? []).slice(0, 20)) {
        if (recommendations.some((input) => input.path === issue.path)) {
          fail(
            'premise_unsupported',
            issue.path,
            credentialDetected(issue.message, args.secrets)
              ? 'Unsupported premise; sensitive diagnostic omitted'
              : issue.message
                  .replace(/[\u0000-\u001f\u007f]/g, ' ')
                  .slice(0, 1000),
          );
        }
      }
    }
  }

  if (errors.length) {
    return { valid: false, outcome: 'invalid_copy', errors };
  }

  const provenance: AgentCopyProvenance = {
    kind: 'agent',
    runId: args.runId,
    ...copyDependencies(args.grounding, profile),
    draft,
    factFingerprints: Object.fromEntries(
      [...used].map(([id, fact]) => [id, factFingerprint(fact)]),
    ),
  };

  return {
    valid: true,
    outcome: 'valid',
    errors: [],
    copy,
    provenance,
    receipt: {
      checkerVersion: copyCheckerVersion,
      runId: args.runId,
      reportKey: args.config.reportKey,
      configVersion:
        args.configVersion ??
        args.grounding?.configIdentity.configVersion ??
        null,
      configDigest: jsonDigest(args.config),
      ...copyDependencies(args.grounding, profile),
      digest: copyReceiptDigest(copy, provenance),
      verifierModel,
      verifierProfile: profile,
      validatedAt: new Date().toISOString(),
    },
  };
};

/** Receipts from this checker on hash the reviewed content without the brand
 * logo. The logo is presentation, not reviewed prose: it is applied to the
 * copy after validation, so a receipt that bound the logo failed at
 * publication for every first report with one (harness era, 2026-09).
 * Earlier receipts hashed the exact bytes they were issued for and keep
 * validating only those bytes. */
const logoAgnosticReceiptVersion = 7;

export const copyReceiptDigest = (
  copy: AeoReportCopy,
  provenance: CopyProvenance,
  checkerVersion = copyCheckerVersion,
): string => {
  const { brandLogo: _brandLogo, ...reviewed } = copy;

  return jsonDigest({
    copy: checkerVersion >= logoAgnosticReceiptVersion ? reviewed : copy,
    provenance,
  });
};

export type CopyFactsUnchangedOptions = {
  snapshot: AeoSnapshot;
  config: AeoAuditConfig;
  runId: string;
  grounding?: GroundingBundle;
  verifierProfile: InternalModelRoleConfig;
};

export const copyFactsUnchanged = (
  provenance: CopyProvenance,
  {
    snapshot,
    config,
    runId,
    grounding,
    verifierProfile,
  }: CopyFactsUnchangedOptions,
): boolean => {
  const facts = new Map(
    buildFactCatalog({ snapshot, config, runId, grounding }).facts.map(
      (fact) => [fact.factId, fact],
    ),
  );

  return (
    [1, 2, 3, premiseVerifierPromptVersion].includes(
      provenance.verifierPromptVersion,
    ) &&
    canonicalJson(
      copyDependencies(
        grounding,
        verifierProfile,
        provenance.verifierPromptVersion,
      ),
    ) ===
      canonicalJson({
        catalogVersion: provenance.catalogVersion,
        groundingDigest: provenance.groundingDigest,
        sourceBundleDigest: provenance.sourceBundleDigest,
        assessmentDigests: provenance.assessmentDigests,
        verifierProfileDigest: provenance.verifierProfileDigest,
        verifierPromptVersion: provenance.verifierPromptVersion,
      }) &&
    Object.entries(provenance.factFingerprints).every(([id, fingerprint]) => {
      const fact = facts.get(id);

      return !!fact && factFingerprint(fact) === fingerprint;
    })
  );
};

const jsonDigest = (value: unknown): string => {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
};

/**
 * configDigests returns the digests that identify one approved config. A
 * config stored before a schema default existed (`surfaces`, 15 September
 * 2026) hashes differently raw and parsed: the report job issues receipts
 * over the parsed config while gates and publication read the stored row.
 */
const configDigests = (config: AeoAuditConfig): string[] => {
  return [jsonDigest(config), jsonDigest(aeoAuditConfigSchema.parse(config))];
};

const copyDependencies = (
  grounding: GroundingBundle | undefined,
  profile: InternalModelRoleConfig,
  verifierPromptVersion = premiseVerifierPromptVersion,
): CopyDependencies => {
  return {
    catalogVersion: factCatalogVersion,
    groundingDigest: grounding?.digest ?? null,
    sourceBundleDigest: grounding?.sourceBundleDigest ?? null,
    assessmentDigests: Object.fromEntries(
      (grounding?.assessments ?? []).map((assessment) => [
        assessment.claimId,
        assessment.digest,
      ]),
    ),
    verifierProfileDigest: internalModelRoleDigest(profile),
    verifierPromptVersion,
  };
};

/**
 * validateHumanCopy reviews human copy. Human authors keep their wording; every
 * assertion and implied premise gets the same evidence review as generated
 * recommendations. Call outside a DB tx.
 */
export const validateHumanCopy = async (args: {
  copy: unknown;
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  runId: string;
  configVersion: number;
  grounding: GroundingBundle;
  verifier: RecommendationVerifier;
  verifierProfile: InternalModelRoleConfig;
  secrets?: readonly string[];
  signal?: AbortSignal;
}): Promise<
  Omit<CopyValidationResult, 'provenance'> & {
    provenance?: HumanCopyProvenance;
  }
> => {
  const reject = (
    code: string,
    message: string,
    outcome: CopyValidationOutcome = 'invalid_copy',
  ) => {
    return {
      valid: false,
      outcome,
      errors: [{ code, path: 'copy', message }],
    };
  };

  if (credentialDetected(JSON.stringify(args.copy), args.secrets)) {
    return reject(
      'credential_detected',
      'Credential-shaped output is forbidden',
    );
  }

  const parsed = aeoReportCopySchema.safeParse(args.copy);

  if (!parsed.success || parsed.data.reportKey !== args.config.reportKey) {
    return reject(
      'schema_invalid',
      'Human copy must belong to the report and match the copy schema',
    );
  }

  const copy = parsed.data;

  if (
    args.config.sections.some(
      ({ key }) => !Object.hasOwn(copy.sections, key),
    ) ||
    Object.keys(copy.sections).some(
      (key) => !args.config.sections.some((section) => section.key === key),
    )
  ) {
    return reject(
      'section_missing',
      'Human copy must cover exactly the configured sections',
    );
  }

  const profile = args.verifierProfile;
  let facts: ReportFact[];

  try {
    validateGroundingBundle(args.grounding, {
      reportKey: args.config.reportKey,
      runId: args.runId,
      configVersion: args.configVersion,
    });
    facts = buildFactCatalog({
      snapshot: args.snapshot,
      config: args.config,
      runId: args.runId,
      grounding: args.grounding,
    }).facts;
  } catch {
    return reject(
      'grounding_invalid',
      'Human copy requires valid frozen evidence for this run',
      'integrity_error',
    );
  }

  const inputs: RecommendationInput[] = [];
  const pending = pendingReportCopy(args.config);
  // These exact host values describe the publisher, pending UI and frozen run
  // metadata. Any edited wording still receives the full semantic review.
  const hostValues = new Map<string, string>([
    ['copy.preparedBy', pending.preparedBy],
    ['copy.pendingBadge', pending.pendingBadge],
    ['copy.pendingBody', pending.pendingBody],
    ['copy.methodologyNote', methodologyNote(args.snapshot)],
  ]);
  const visit = (value: unknown, path: string) => {
    if (hostValues.has(path) && value === hostValues.get(path)) {
      return;
    }

    if (typeof value === 'string' && value.trim()) {
      inputs.push({
        kind: 'human_copy',
        text: value,
        intendedAction: null,
        premises: [],
        facts,
        path,
      });
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}.${index}`));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => {
        if (!['reportKey', 'anchor', 'brandLogo'].includes(key)) {
          visit(child, `${path}.${key}`);
        }
      });
    }
  };
  visit(copy, 'copy');
  let result: Awaited<ReturnType<RecommendationVerifier>>;

  try {
    result = await args.verifier(inputs, args.signal);
  } catch (error) {
    const outcome = classifyVerifierFailure(error, args.signal);

    return reject(
      verifierFailureCodes[outcome],
      'Human copy requires a successful semantic evidence review',
      outcome,
    );
  }

  if (result.model !== profile.model) {
    return reject(
      'premise_verifier_invalid',
      'Semantic verification did not use the pinned verifier',
      'invalid_review',
    );
  }

  if (result.valid !== true || result.errors.length) {
    const issues = (result.issues ?? [])
      .flatMap((issue) => {
        if (!inputs.some((input) => input.path === issue.path)) {
          return [];
        }

        return [
          {
            code: 'premise_unsupported',
            path: issue.path,
            message: credentialDetected(issue.message, args.secrets)
              ? 'Unsupported premise; sensitive diagnostic omitted'
              : issue.message
                  .replace(/[\u0000-\u001f\u007f]/g, ' ')
                  .slice(0, 1000),
          },
        ];
      })
      .slice(0, 20);

    return issues.length
      ? { valid: false, outcome: 'invalid_copy' as const, errors: issues }
      : reject(
          'premise_unsupported',
          'Human copy contains unsupported or irrelevant factual premises',
        );
  }

  const usedBasisIds = result.basisFactIds ?? [];

  if (usedBasisIds.some((id) => !facts.some((fact) => fact.factId === id))) {
    return reject(
      'premise_basis_invalid',
      'Verifier referenced an unknown factual basis',
      'invalid_review',
    );
  }

  const dependencies = copyDependencies(args.grounding, profile);
  const provenance: HumanCopyProvenance = {
    kind: 'human',
    runId: args.runId,
    ...dependencies,
    factFingerprints: Object.fromEntries(
      facts
        .filter((fact) => usedBasisIds.includes(fact.factId))
        .map((fact) => [fact.factId, factFingerprint(fact)]),
    ),
  };

  return {
    valid: true,
    outcome: 'valid',
    errors: [],
    copy,
    provenance,
    receipt: {
      checkerVersion: copyCheckerVersion,
      reportKey: args.config.reportKey,
      runId: args.runId,
      configVersion: args.configVersion,
      configDigest: jsonDigest(args.config),
      ...dependencies,
      digest: copyReceiptDigest(copy, provenance),
      verifierModel: profile.model,
      verifierProfile: profile,
      validatedAt: new Date().toISOString(),
    },
  };
};

// The stored receipt and provenance are checked field by field against
// recomputed evidence below, and the receipt digest hashes the whole
// provenance, so these guards only establish the shape those checks read.
const isStoredReceipt = (
  value: unknown,
): value is CopyValidationReceipt & Record<string, unknown> => {
  return isRecord(value);
};

export const isStoredProvenance = (value: unknown): value is CopyProvenance => {
  return isRecord(value) && (value.kind === 'agent' || value.kind === 'human');
};

/**
 * assertCopyValidation checks the stored receipt, recomputed from immutable
 * data inside every publication transaction. No human approval or allowPartial
 * switch can replace the evidence receipt.
 */
export const assertCopyValidation = (args: {
  copy: AeoReportCopy;
  provenance: unknown;
  receipt: unknown;
  config: AeoAuditConfig;
  configVersion: number;
  snapshot: AeoSnapshot;
  runId: string;
  grounding: unknown;
  verifierProfile: InternalModelRoleConfig;
}): CopyValidationReceipt => {
  const grounding = validateGroundingBundle(args.grounding, {
    reportKey: args.config.reportKey,
    configVersion: args.configVersion,
    runId: args.runId,
  });
  const receipt = isStoredReceipt(args.receipt) ? args.receipt : null;
  const provenance = isStoredProvenance(args.provenance)
    ? args.provenance
    : null;
  const profile = args.verifierProfile;
  const verifierPromptVersions: Record<number, number> = {
    3: 1,
    4: 2,
    5: 3,
    6: 3,
    7: 3,
    [copyCheckerVersion]: premiseVerifierPromptVersion,
  };
  const verifierPromptVersion = receipt
    ? verifierPromptVersions[receipt.checkerVersion]
    : undefined;
  const expected = copyDependencies(grounding, profile, verifierPromptVersion);
  const draft =
    provenance?.kind === 'agent'
      ? aeoAgentCopyDraftSchema.parse(provenance.draft)
      : undefined;
  const hasNarrative = draft?.intro.some((block) => block.kind === 'narrative');

  if (
    !receipt ||
    !provenance ||
    !verifierPromptVersion ||
    (draft?.hero && receipt.checkerVersion < 5) ||
    (hasNarrative &&
      (receipt.checkerVersion === 3 ||
        receipt.verifierModel !== profile.model)) ||
    receipt.reportKey !== args.config.reportKey ||
    receipt.runId !== args.runId ||
    provenance.runId !== args.runId ||
    receipt.configVersion !== args.configVersion ||
    !configDigests(args.config).includes(receipt.configDigest) ||
    receipt.digest !==
      copyReceiptDigest(args.copy, provenance, receipt.checkerVersion) ||
    !Number.isFinite(Date.parse(receipt.validatedAt)) ||
    !['no-recommendations', profile.model].includes(receipt.verifierModel) ||
    internalModelRoleDigest(receipt.verifierProfile) !==
      expected.verifierProfileDigest ||
    Object.entries(expected).some(
      ([key, value]) => canonicalJson(receipt[key]) !== canonicalJson(value),
    ) ||
    !copyFactsUnchanged(provenance, {
      snapshot: args.snapshot,
      config: args.config,
      runId: args.runId,
      grounding,
      verifierProfile: profile,
    })
  ) {
    throw new Error(
      `Copy validation receipt is missing, stale, or inconsistent with frozen evidence for run: ${args.runId}.`,
    );
  }

  return receipt;
};
