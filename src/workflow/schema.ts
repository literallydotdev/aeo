import { z } from 'zod';
import { reportKeySchema } from '../report/contracts';
import { coverageThresholdsSchema } from '../coverage-schema';
import { probeLimitsSchema } from '../probes/limits';
import {
  reportAudienceSchema,
  type RequestClientAccess,
  type TokenAccess,
} from '../access/schema';
import {
  modelBudgetLimitsSchema,
  type ModelBudgetLimits,
} from '../models/accounting';
import {
  generationBackendSchema,
  internalModelProfileIdSchema,
  internalModelProfileSchema,
  type GenerationBackend,
} from '../models/profiles';
import { lineageDepthLimit } from './lineage';

export { reportKeySchema } from '../report/contracts';

export const gateSchema = z.enum(['config', 'copy', 'publish']);
export type Gate = z.infer<typeof gateSchema>;

// Every gate is `auto` unless an operator asks for `human` to debug a run.
export const gatePolicySchema = z.enum(['auto', 'human']);
export type GatePolicy = z.infer<typeof gatePolicySchema>;

export const gatesSchema = z
  .object({
    config: gatePolicySchema.optional(),
    copy: gatePolicySchema.optional(),
    publish: gatePolicySchema.optional(),
  })
  .strict();

export type ResolvedGates = Record<
  Gate,
  { value: GatePolicy; source: 'default' | 'request' }
>;

export const scopeSchema = z.enum([
  'pipelines:write',
  'pipelines:read',
  'pipelines:review',
  'gates:override',
  'configs:read',
  'configs:write',
  'runs:write',
  'runs:read',
  'reports:read',
  'reports:published:read',
  'reports:public:create',
  'reports:access:write',
]);
export type Scope = z.infer<typeof scopeSchema>;

export const briefSchema = z
  .object({
    companyName: z.string().trim().min(1).max(256),
    website: z
      .url()
      .max(2048)
      .refine((value) => ['https:', 'http:'].includes(new URL(value).protocol)),
    desiredRecommendation: z.string().trim().min(1).max(5000),
    competitors: z.string().max(5000).optional(),
    moneyPages: z.string().max(5000).optional(),
    notes: z.string().max(5000).optional(),
  })
  .strict();

/**
 * harnessPolicySchema is pinned at admission: every pipeline runs the report
 * job (aeo/jobs/report.ts) after config approval, so `required` is always true
 * on a new admission and `version` names the policy shape. Not strict on
 * purpose: admissions stored before the runner was folded into one path carry
 * the retired `runner` and `derive` keys, which a resume must read past rather
 * than refuse.
 */
export const harnessPolicySchema = z.object({
  required: z.boolean(),
  version: z.literal(1),
});
export type HarnessAdmissionPolicy = z.infer<typeof harnessPolicySchema>;

export const pipelineRequestSchema = z
  .object({
    // TODO: Remove once the console stops sending a tier. Tiers no longer
    // exist; the key is accepted from older clients and discarded below.
    tier: z.enum(['free', 'paid']).optional(),
    harness: harnessPolicySchema.optional(),
    brief: briefSchema.optional(),
    reportKey: reportKeySchema.optional(),
    audience: reportAudienceSchema.optional(),
    submissionId: z.string().min(1).max(128).optional(),
    gates: gatesSchema.default({}),
    authorAgent: generationBackendSchema.optional(),
    copyAgent: generationBackendSchema.optional(),
    modelProfileId: internalModelProfileIdSchema.optional(),
    modelProfile: internalModelProfileSchema.optional(),
    modelBudget: modelBudgetLimitsSchema.optional(),
    run: z
      .object({
        mode: z.enum(['fresh', 'resume']).default('fresh'),
        /** See `runRequestSchema.grounding`. */
        grounding: z.enum(['full', 'extraction_only']).default('full'),
        maxPlannedUnits: z.number().int().positive().default(400),
        allowPartial: z.boolean().default(false),
        coverageThresholds: coverageThresholdsSchema.optional(),
        limits: probeLimitsSchema.optional(),
      })
      .strict()
      .prefault({}),
    copy: z.enum(['draft', 'skip', 'regenerate']).default('draft'),
    maxIterations: z.number().int().positive().default(3),
    callbackUrl: z.url().max(2048).optional(),
    label: z.string().max(256).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.brief ?? value.reportKey), {
    message: 'A brief or explicit reportKey is required',
  })
  .transform(({ tier: _tier, ...request }) => request);
export type PipelineRequest = z.infer<typeof pipelineRequestSchema>;

export const pipelineStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'cancelling',
  'published',
  'rejected',
  'failed',
  'cancelled',
]);
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

export type PipelineStage = 'author' | 'run' | 'copy' | 'publish' | 'done';

export const activeStatuses = [
  'starting',
  'running',
  'waiting',
  'cancelling',
] as const;

export const isTerminal = (status: string): boolean => {
  return ['published', 'rejected', 'failed', 'cancelled'].includes(status);
};

export const tripleSchema = z
  .object({
    runId: z.string().min(1),
    configVersion: z.number().int().positive(),
    copyVersion: z.number().int().positive(),
  })
  .strict();
export type ArtifactTriple = z.infer<typeof tripleSchema>;

export const gateTargetSchema = z.union([
  z.object({ version: z.number().int().positive() }).strict(),
  tripleSchema,
]);
export type GateTarget = z.infer<typeof gateTargetSchema>;

export const reviewRequestSchema = z
  .object({
    gateId: z.string().min(1).max(128),
    expectedVersion: z.number().int().positive().optional(),
    expectedTarget: tripleSchema.optional(),
    note: z.string().max(5000).optional(),
    notes: z.string().min(1).max(5000).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.expectedVersion) !== Boolean(value.expectedTarget),
    { message: 'Supply expectedVersion or expectedTarget' },
  );

export type GateReview = {
  gateId: string;
  gate: Gate;
  action: 'approve' | 'request_changes' | 'reject';
  target: GateTarget;
  note: string | null;
  tokenId: string;
  acceptedAt: string;
  deliveredAt: string | null;
  appliedAt: string | null;
};

/**
 * pipelineCallbackSchema is the signed callback body. Not strict on purpose:
 * the signature already authenticates the exact bytes, so a receiver behind
 * the sender's build ignores an additive field instead of burning the
 * sender's attempts.
 */
export const pipelineCallbackSchema = z.object({
  eventId: z.string().min(1),
  event: z.enum([
    'gate_waiting',
    'pipeline_published',
    'pipeline_rejected',
    'pipeline_failed',
    'pipeline_cancelled',
  ]),
  pipelineId: z.string().min(1),
  /** Stored retry lineage, supplied by the signing workflow host only. */
  retryAncestorIds: z
    .array(z.string().min(1))
    .max(lineageDepthLimit)
    .optional(),
  submissionId: z.string().optional(),
  reportKey: reportKeySchema,
  status: pipelineStatusSchema,
  reason: z.string().nullable(),
  reportUrl: z.url().nullable(),
  gate: gateSchema.nullable(),
  gateId: z.string().nullable(),
  gateTarget: gateTargetSchema.nullable(),
  sentAt: z.iso.datetime(),
});
export type PipelineCallback = z.infer<typeof pipelineCallbackSchema>;

export type CallbackEvent = {
  logicalKey: string;
  body: PipelineCallback;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  nextAttemptAt: string | null;
};

export type ApiToken = {
  id: string;
  /** Stored access, or the client a resolved integration token acts for. */
  access?: TokenAccess | RequestClientAccess;
  scopes: Scope[];
  maxPlannedUnits: number;
  maxPipelinesPerDay: number;
  maxActivePipelines: number;
  defaultAuthorAgent: GenerationBackend;
};

export type PipelineLimits = {
  stateMachineArn: string;
  maxPlannedUnits: number;
  maxIterations: number;
  maxDeferrals: number;
  maxPipelinesPerDay: number;
  admissionsEnabled: boolean;
  callbackHosts: string[];
  siteUrl: string;
  modelBudget?: ModelBudgetLimits;
};
