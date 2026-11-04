import {
  internalModelProfileSchema,
  type CodexStageModel,
  type InternalModelProfile,
  type InternalModelRole,
  type InternalModelRoleConfig,
} from './profiles';
import type { SupportedModel } from './supported-models';

// ============================================================================
// The profile a local run executes under (specs/aeo-claude-operator-spec.md
// §4.1): every text role and the Codex stages on the one model audit.json
// names, with the role settings below. The run freezes the model
// (BUDGET.json); the profile is built from it by the running engine on every
// invocation and recorded with the run as part of its method.
// ============================================================================

/** Bumped when a role's prompt changes what it asks for. */
const promptVersions: Partial<Record<InternalModelRole, number>> = {
  copy: 5,
  premiseVerifier: 5,
  analyzer: 3,
  research: 2,
  adjudication: 2,
  competitorClassifier: 2,
  domainClassifier: 2,
};

/** Bumped when a role's output schema changes. */
const schemaVersions: Partial<Record<InternalModelRole, number>> = {
  copy: 3,
  adjudication: 2,
  premiseVerifier: 2,
};

/** Room to think, on top of what the answer itself is allowed, for a model
 * that bills its reasoning as output. One number for every role: how hard
 * a task is to think through has little to do with how long its answer
 * runs. */
const reasoningAllowanceTokens = 32_768;

type RoleSizing = {
  /** The answer's own room, before any reasoning allowance. */
  maxOutputTokens: number;
  deadlineMs: number;
};

/** What each role is allowed per call. Batched roles keep their call
 * site's own ceiling on items per call. */
const roleSizing: Record<
  Exclude<
    InternalModelRole,
    'logoDiscovery' | 'scrutiny' | 'repairPlanner' | 'visualReviewer'
  >,
  RoleSizing
> = {
  analyzer: { maxOutputTokens: 16_384, deadlineMs: 180_000 },
  perception: { maxOutputTokens: 16_384, deadlineMs: 300_000 },
  research: { maxOutputTokens: 4096, deadlineMs: 60_000 },
  adjudication: { maxOutputTokens: 16_384, deadlineMs: 300_000 },
  premiseVerifier: { maxOutputTokens: 8192, deadlineMs: 180_000 },
  author: { maxOutputTokens: 24_576, deadlineMs: 300_000 },
  copy: { maxOutputTokens: 24_576, deadlineMs: 300_000 },
  domainClassifier: { maxOutputTokens: 16_384, deadlineMs: 180_000 },
  competitorClassifier: { maxOutputTokens: 8192, deadlineMs: 300_000 },
};

const createRoleConfig = (
  name: InternalModelRole,
  model: SupportedModel,
  sizing: RoleSizing,
): InternalModelRoleConfig => {
  const allowance = model.thinkingInOutput ? reasoningAllowanceTokens : 0;

  const roleConfig: InternalModelRoleConfig = {
    model: model.id,
    providerOptions: model.providerOptions,
    promptVersion: `${name}-grounding-v${promptVersions[name] ?? 1}`,
    schemaVersion: `${name}-v${schemaVersions[name] ?? 1}`,
    deadlineMs: sizing.deadlineMs,
    maxInputTokens: 80_000,
    maxOutputTokens: Math.min(
      sizing.maxOutputTokens + allowance,
      model.maxOutputTokens,
    ),
    pricingUsdPerMillion: model.pricingUsdPerMillion,
  };

  return roleConfig;
};

/** The Codex stages' settings for a supported model. */
export const localStageModel = (model: SupportedModel): CodexStageModel => {
  return {
    model: model.id,
    reasoningEffort: model.stageReasoningEffort,
    contextWindow: model.contextWindow,
    pricingUsdPerMillion: model.pricingUsdPerMillion,
  };
};

type LocalModelProfileOptions = {
  /** Full grounding researches through the pinned search provider; it is
   * pinned by the audit, never inferred from which credentials are set. */
  searchProvider: InternalModelProfile['searchProvider'];
};

/** localModelProfile builds the profile a local run pins for `model`. */
export const localModelProfile = (
  model: SupportedModel,
  { searchProvider }: LocalModelProfileOptions,
): InternalModelProfile => {
  const role = (name: keyof typeof roleSizing) => {
    return createRoleConfig(name, model, roleSizing[name]);
  };

  const roles = {
    analyzer: role('analyzer'),
    perception: role('perception'),
    research: role('research'),
    adjudication: role('adjudication'),
    premiseVerifier: role('premiseVerifier'),
    author: role('author'),
    copy: role('copy'),
    domainClassifier: role('domainClassifier'),
    competitorClassifier: role('competitorClassifier'),
  };

  const profile = internalModelProfileSchema.parse({
    id: `local:${model.id}`,
    version: 1,
    pricingCheckedAt: model.pricingCheckedAt,
    searchProvider,
    roles: {
      ...roles,
      logoDiscovery: {
        ...createRoleConfig('logoDiscovery', model, {
          maxOutputTokens: 1024,
          deadlineMs: 60_000,
        }),
        promptVersion: 'logoDiscovery-grounding-v2',
        schemaVersion: 'logoDiscovery-v2',
        maxInputTokens: 24_000,
      },
    },
    stages: localStageModel(model),
  });

  return profile;
};
