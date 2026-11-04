import { z } from 'zod';
import type { AeoAuditConfig, RunRequest } from '../schema';
import type { AnalysisStore } from '../stores/ports';
import { resolveDataForSeoLocale } from '../probes/dataforseo-locale';
import { contentHash } from '../stores/content-hash';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import type { InternalModelContext } from '../models/context';
import { createLog } from '../lib/log';
import {
  extractionCacheRunIdsFromManifest,
  savedAnswersFromManifest,
  validateCaptureManifest,
  type CaptureManifest,
} from '../capture-manifest';
import { withModelBudgetProtection } from '../models/budget-protection';
import type { ExecutionRecorder } from '../bundle/recorder';
import { recordedGroundingTools } from './recorded-tools';
import { createGroundingTools, createDataForSeoSearchAdapter } from './tools';
import { createGatewayGroundingModel } from './model';
import {
  candidateInventoryPolicyVersion,
  claimExtractionIdentity,
  extractClaimCandidates,
  validatedExtractionBatchSchema,
} from './extract';
import { researchProfileFromModels } from './profile';
import {
  claimCandidateSchema,
  groundingCoverageSchema,
  type GroundingBundle,
  groundingPolicyVersion,
  groundingSchemaVersion,
} from './schema';
import { runGroundingResearch } from './controller';
import type { ResearchOwner, ResearchSessionStore } from './session';
import {
  createGroundingBundle,
  validateCandidateOccurrences,
} from './validation';

const log = createLog('Grounding');

const extractionSchema = z.object({
  candidates: z.array(claimCandidateSchema),
  coverage: z.object({
    extractionStopReason: groundingCoverageSchema.shape.extractionStopReason,
    suppliedAnswers: z.number().int().nonnegative(),
    extractedAnswers: z.number().int().nonnegative(),
    truncatedAnswers: z.number().int().nonnegative(),
    droppedClaims: groundingCoverageSchema.shape.droppedClaims,
    droppedClaimsByAnswer: groundingCoverageSchema.shape.droppedClaimsByAnswer,
  }),
});

export type GroundedRunRuntime = {
  internalModels: InternalModelContext;
  ground: (
    manifest: CaptureManifest,
    options?: {
      revisionSalt?: string;
      /** The accounting this grounding charges: the runtime's own by
       * default; the workflow passes the same ledger wrapped by its run
       * journal, so every grounding model call is recorded. */
      accounting?: ModelCallAccounting;
    },
  ) => Promise<GroundingBundle>;
  close: () => Promise<void>;
};

export type GroundingRuntimeArgs = {
  request: RunRequest;
  config: AeoAuditConfig;
  analysisStore: AnalysisStore;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  pipelineId?: string;
  /** Extra reservation policy layered over the pinned budget protection,
   * such as the harness's mandatory obligation ledger. */
  protectAccounting?: (accounting: ModelCallAccounting) => ModelCallAccounting;
  /** The run's model ledger and research sessions, wherever they are kept. */
  rawAccounting: ModelCallAccounting;
  store: ResearchSessionStore;
  owner: ResearchOwner;
  /** The run journal: each research search and fetch is an operation. */
  recorder?: ExecutionRecorder;
  close: () => Promise<void>;
};

/**
 * openGroundingRuntime is grounding with its storage supplied: the hosted
 * runtime passes Postgres or the checkout's files, a local run its own run
 * directory. Nothing here reads a database URL.
 */
export const openGroundingRuntime = (
  args: GroundingRuntimeArgs,
): GroundedRunRuntime => {
  const { request, config, rawAccounting, store, owner } = args;
  const profile = request.modelProfile;
  const budget = request.modelBudget;

  if (!profile || !budget) {
    throw new ModelBudgetError(
      'model_budget_missing: pin an internal model profile and budget before running',
    );
  }

  const guarded = withModelBudgetProtection(rawAccounting, profile);
  const runtimeAccounting = args.protectAccounting?.(guarded) ?? guarded;

  const runtime: GroundedRunRuntime = {
    internalModels: { profile, accounting: runtimeAccounting },
    close: args.close,
    ground: async (manifest, options = {}) => {
      const accounting = options.accounting ?? runtimeAccounting;

      validateCaptureManifest(manifest, {
        reportKey: config.reportKey,
        runId: request.runId,
      });

      const answers = savedAnswersFromManifest(manifest);
      const key = `claim-extraction:v2:${contentHash({ manifest: manifest.digest, extractionIdentity: claimExtractionIdentity(config.brand.name, profile.roles.perception), inventoryPolicyVersion: candidateInventoryPolicyVersion })}`;
      let extraction = await args.analysisStore.get(key, extractionSchema);

      if (!extraction) {
        extraction = await extractClaimCandidates({
          answers,
          priorAnswerRunIds: extractionCacheRunIdsFromManifest(manifest),
          product: config.brand.name,
          role: profile.roles.perception,
          accounting,
          signal: args.signal,
          onProgress: (progress) => {
            log.info('Claim extraction batch completed', {
              runId: request.runId,
              ...progress,
            });
          },
          batchCache: {
            get: (batchKey) =>
              args.analysisStore.get(batchKey, validatedExtractionBatchSchema),
            put: async (batchKey, batch) => {
              args.signal?.throwIfAborted();
              await accounting.assertOwned();
              await args.analysisStore.put(batchKey, batch, {
                runId: request.runId,
                modelId: profile.roles.perception.model,
                version: 1,
              });
            },
          },
          onDiagnostic: async (diagnostic) => {
            args.signal?.throwIfAborted();
            await accounting.assertOwned();

            // Private debugging evidence is never read through the validated
            // claim-extraction cache key or accepted as candidate inventory.
            await args.analysisStore.put(
              `untrusted-extraction-diagnostic:${request.runId}:${diagnostic.callId}`,
              {
                ...diagnostic,
                manifestDigest: manifest.digest,
                roleDigest: contentHash(profile.roles.perception),
              },
              {
                runId: request.runId,
                modelId: profile.roles.perception.model,
                version: 1,
              },
            );
          },
        });
        args.signal?.throwIfAborted();
        await accounting.assertOwned();

        if (
          ['complete', 'inventory_limit'].includes(
            extraction.coverage.extractionStopReason ?? '',
          )
        ) {
          await args.analysisStore.put(key, extraction, {
            runId: request.runId,
            modelId: profile.roles.perception.model,
            version: 2,
          });
        }
      }

      for (const candidate of extraction.candidates) {
        validateCandidateOccurrences(candidate, answers);
      }

      // Research disabled by the run request: the claim inventory is kept,
      // nothing is searched or adjudicated, and every selected claim stays
      // unresolved as not researched. The bundle is still a valid, frozen
      // grounding artifact, so checks, digests and the copy's fact catalog
      // read it exactly as they would a researched one with no support.
      if (request.grounding === 'extraction_only') {
        const selected = extraction.candidates.filter(
          (candidate) => candidate.disposition === 'selected',
        );

        return createGroundingBundle({
          schemaVersion: groundingSchemaVersion,
          policyVersion: groundingPolicyVersion,
          configIdentity: {
            reportKey: config.reportKey,
            configVersion: request.configVersion ?? 1,
          },
          runId: request.runId,
          reviewAsOf: manifest.createdAt,
          sources: [],
          facts: config.productGrounding?.facts ?? [],
          candidates: extraction.candidates,
          assessments: [],
          adjudication: null,
          coverage: {
            ...extraction.coverage,
            selectedCandidates: selected.length,
            overflowCandidates: extraction.candidates.filter(
              (candidate) => candidate.disposition === 'overflow',
            ).length,
            stopReason: 'research_disabled',
            retrievals: [],
            gaps: selected.length
              ? [
                  {
                    candidateIds: selected
                      .slice(0, 40)
                      .map((candidate) => candidate.id),
                    reason: 'not_researched',
                  },
                ]
              : [],
          },
        });
      }

      const publicSearchTerms = [config.brand.name, config.brand.domain];
      const search =
        profile.searchProvider === 'dataforseo-google-organic-v1' &&
        args.env.DATAFORSEO_LOGIN &&
        args.env.DATAFORSEO_PASSWORD
          ? createDataForSeoSearchAdapter({
              login: args.env.DATAFORSEO_LOGIN,
              password: args.env.DATAFORSEO_PASSWORD,
              // The config's own market; an unmapped one keeps the US
              // default it always had (a local audit.json refuses it).
              ...(resolveDataForSeoLocale(
                config.geography,
                config.language,
              ) ?? {
                locationCode: 2840,
                languageCode: 'en',
              }),
            })
          : undefined;
      const created = createGroundingTools({
        answers,
        publicSearchTerms,
        firstPartyHosts: [config.brand.domain],
        searchProvider: profile.searchProvider,
        search,
      });
      const tools = args.recorder
        ? recordedGroundingTools(created, args.recorder)
        : created;

      return runGroundingResearch({
        phase: 'audit',
        configIdentity: {
          reportKey: config.reportKey,
          configVersion: request.configVersion ?? 1,
        },
        runId: request.runId,
        reviewAsOf: manifest.createdAt,
        baseBundle: config.productGrounding,
        candidates: extraction.candidates,
        answers,
        knownUrls: [`https://${config.brand.domain}/`],
        publicSearchTerms,
        coverage: extraction.coverage,
        store,
        owner,
        accounting,
        tools,
        profile: researchProfileFromModels(profile, {
          limits: budget,
          phase: 'audit',
          searchProvider: tools.searchProvider,
          purpose:
            request.derivedFromRunId && !args.pipelineId
              ? 'grounding_replay'
              : 'pipeline',
        }),
        model: createGatewayGroundingModel({
          researchRole: profile.roles.research,
          adjudicationRole: profile.roles.adjudication,
          accounting,
        }),
        signal: args.signal,
        jobDeadlineAt: budget.deadlineAt,
        onProgress: (progress) => {
          log.info('Factual evidence review', {
            runId: request.runId,
            ...progress,
          });
        },
        revisionSalt: options.revisionSalt,
      });
    },
  };

  return runtime;
};
