import { createHash } from 'node:crypto';
import { APICallError } from 'ai';
import { z } from 'zod';
import { producerGuidance } from '../harness/criteria';
import type { InternalModelContext } from '../models/context';
import { generateStructured } from '../models/structured';
import { internalModelRoleDigest } from '../models/profiles';
import { batchModelInputs } from '../models/batching';
import { askUntilCovered } from '../models/coverage-rounds';
import { ModelBudgetError } from '../models/accounting';
import type { AeoVisibility, SourceCategory } from '../schema';
import { sourceCategories } from '../schema';
import { createLog } from '../lib/log';
import { isGroundingRedirectUrl } from '../probes/grounding-urls';
import { codepointCompare } from '../lib/analysis-checkpoint';
import {
  domainClassifierVersion,
  learnedLabels,
  type DomainLabelsFile,
} from './domain-labels';
import { hostMatchesDomain } from './domain-match';
import { normalizeDomain } from './scoring';
import {
  citedHost,
  classifySource,
  competitorSourceAllowed,
  sectionSourceClassifierConfig,
  type SourceClassifierConfig,
} from './source-classifier';
import { qualifiedCompetitorsForRow } from './qualified-competitors';

// File shape, version, and the flat-map helper live in the runner-free
// domain-labels.ts (the report page imports them too); re-exported here so
// the runner sees one module.
export {
  domainClassifierVersion,
  domainLabelsFile,
  domainLabelsFileSchema,
  learnedLabels,
} from './domain-labels';

export type { DomainLabelsFile } from './domain-labels';

const log = createLog('DomainClassifier');

// ============================================================================
// Learned domain labels (spec §7.1 amendment, 2026-09-04). The static
// classifier knows the brand, the scored competitors, and two fixed rosters;
// everything else is "earned". In a market where the answers are lists of
// vendors (agencies, tools), most cited domains are unscored competitors, and
// the Literally.dev baseline landed at ~15% correct earned labels. Two
// layers fix that, in order:
//
//   1. Qualified competitors: contextual entity review identifies vendors;
//      historical rows fall back to their configured competitor roster.
//   2. Model pass (cents): the hosts still unlabeled are sent to a model in
//      batches with the market context (brand, brief, prompts) and labeled
//      competitor / social / institutional / earned. Never the answer text,
//      only hostnames and sample paths.
//
// Labels are written to content/aeo-insights/<reportKey>/domain-labels.json
// next to the snapshot: they carry no client answers, so committing them is
// safe, and a rerun (any machine) reuses every model label at the same
// version — the pass costs only for hosts it has never seen. The file is the
// audit trail for a label a reader questions; a wrong label is fixed with
// config.sourceOverrides, which wins over everything. The report page reads
// the same file so its opened-pages list agrees with the source mix.
// ============================================================================

// The classifier model without a pinned internal profile (legacy runs). A
// pinned profile's domainClassifier role decides otherwise, and the labels
// file records whichever model actually labeled.
const domainModel = 'anthropic/claude-opus-4.6';
const domainBatchSize = 60;
/** Rounds of asking about the hosts a batch has left unlabelled, the first
 * call included, before the `earned` default stands and reaches the reader
 * as an outreach target. Each round asks only about what is still missing. */
const domainCoverageRounds = 3;
/** Calls one round may spend on a transport failure before the batch is
 * abandoned; the labels its earlier rounds learned are kept. */
const domainTransientAttempts = 3;
const domainRetryDelaysMs = [3_000, 8_000];
const maxSamplePaths = 2;

export type UnlabeledHost = {
  host: string;
  citations: number;
  samplePaths: string[];
  // A host-only classifier cannot override explicit contextual exclusion.
  competitorAllowed?: false;
};

type SectionVisibility = { key: string; visibility: AeoVisibility };

// ---------------------------------------------------------------------------
// Pure derivations (unit-tested)
// ---------------------------------------------------------------------------

/**
 * analyzerBrandDomains returns the domains attached to qualified competitors,
 * minus the client's domain. Raw brand/product mentions never establish
 * competitor eligibility.
 */
export const analyzerBrandDomains = (
  sections: readonly SectionVisibility[],
  brandDomain: string,
): string[] => {
  const domains = new Set<string>();

  for (const section of sections) {
    for (const row of section.visibility.matrix) {
      for (const brand of qualifiedCompetitorsForRow(row)) {
        if (!brand.domain) {
          continue;
        }

        const domain = normalizeDomain(brand.domain)
          .toLowerCase()
          .replace(/^www\./, '');

        if (!domain.includes('.')) {
          continue;
        }

        if (hostMatchesDomain(domain, brandDomain)) {
          continue;
        }

        domains.add(domain);
      }
    }
  }

  return [...domains].sort();
};

/**
 * collectUnlabeledHosts returns the cited hosts the given classifier config
 * still labels "earned", with citation counts and a couple of sample paths for
 * the model's context. Most-cited first, so a truncated batch loses the least.
 */
export const collectUnlabeledHosts = (
  sections: readonly SectionVisibility[],
  config: SourceClassifierConfig,
): UnlabeledHost[] => {
  const byHost = new Map<string, UnlabeledHost>();
  const scopedSections = sections.map((section) => ({
    section,
    sectionConfig: sectionSourceClassifierConfig(
      config,
      section.visibility,
      sections,
    ),
  }));
  const sectionConfigs = scopedSections.map(
    ({ sectionConfig }) => sectionConfig,
  );

  for (const { section, sectionConfig } of scopedSections) {
    for (const row of section.visibility.matrix) {
      for (const url of row.citedUrls ?? []) {
        if (isGroundingRedirectUrl(url)) {
          continue;
        }

        if (classifySource(url, sectionConfig) !== 'earned') {
          continue;
        }

        const host = citedHost(url);

        if (!host) {
          continue;
        }

        const entry = byHost.get(host) ?? {
          host,
          citations: 0,
          samplePaths: [],
          ...(!sectionConfigs.some((scoped) =>
            competitorSourceAllowed(host, scoped),
          )
            ? { competitorAllowed: false as const }
            : {}),
        };
        byHost.set(host, entry);
        entry.citations += 1;
        const samplePath = urlPath(url);

        if (
          samplePath &&
          entry.samplePaths.length < maxSamplePaths &&
          !entry.samplePaths.includes(samplePath)
        ) {
          entry.samplePaths.push(samplePath);
        }
      }
    }
  }

  return [...byHost.values()].sort(
    (a, b) => b.citations - a.citations || a.host.localeCompare(b.host),
  );
};

/**
 * reusableModelLabels returns the model labels from a previous run that are
 * still valid: same classifier version AND same model (hardening spec §2.7).
 * Every such entry is kept, whether or not this run cites the host, so a scoped
 * run never drops the labels of the sections it did not touch.
 */
export const reusableModelLabels = (
  file: DomainLabelsFile | null,
  internalModels?: InternalModelContext,
  contextHash?: string,
): Record<string, SourceCategory> => {
  if (file?.version !== domainClassifierVersion) {
    return {};
  }

  const model =
    internalModels?.profile.roles.domainClassifier.model ?? domainModel;

  if (file.model !== model) {
    return {};
  }

  if (internalModels) {
    const profileDigest = internalModelRoleDigest(
      internalModels.profile.roles.domainClassifier,
    );

    if (
      file.modelProfileDigest !== profileDigest ||
      file.contextHash !== contextHash
    ) {
      return {};
    }
  }

  const labels: Record<string, SourceCategory> = {};

  for (const [host, entry] of Object.entries(file.entries)) {
    if (entry.source === 'model') {
      labels[host] = entry.category;
    }
  }

  return labels;
};

/**
 * domainContextHash hashes the market context the model judged labels in
 * (§2.7).
 */
export const domainContextHash = (context: DomainMarketContext): string => {
  return createHash('sha256')
    .update(
      JSON.stringify({
        brandName: context.brandName,
        brandDomain: context.brandDomain,
        productBrief: context.productBrief,
        promptTexts: [...context.promptTexts].sort(codepointCompare),
      }),
    )
    .digest('hex');
};

/**
 * registrableDomain returns the vendor's own domain: the last two labels, or
 * three under a public second-level suffix such as co.uk or com.au.
 */
export const registrableDomain = (host: string): string => {
  const labels = host.split('.').filter(Boolean);

  if (labels.length <= 2) {
    return host;
  }

  const secondLevel = labels.at(-2);

  if (secondLevel === undefined) {
    throw new Error(`Host has no second-level label: ${host}.`);
  }

  const keep = /^(co|com|org|net|ac|gov|edu)$/.test(secondLevel) ? 3 : 2;

  return labels.slice(-keep).join('.');
};

/**
 * buildDomainLabelsFile builds the committed file: model labels first, then the
 * labels the run itself settles over them: a configured competitor's domain the
 * model judged, and a qualified competitor's domain. Asking the model about
 * vercel.com when Vercel was a configured competitor produced "institutional"
 * (run A, 2026-09-12).
 */
export const buildDomainLabelsFile = (args: {
  analyzerDomains: readonly string[];
  configuredDomains?: readonly string[];
  modelLabels: Record<string, SourceCategory>;
  /** The model that produced the labels; the legacy default when absent. */
  model?: string;
  contextHash?: string;
  modelProfileDigest?: string;
}): DomainLabelsFile => {
  const entries: DomainLabelsFile['entries'] = {};

  for (const [host, category] of Object.entries(args.modelLabels)) {
    entries[host] = { category, source: 'model' };
  }

  // A model label on a configured competitor's own domain is overruled by
  // the configuration: the report's author already declared that company a
  // buyer's alternative. Only judged hosts are touched, so a configured
  // domain the answers never cited gets no entry.
  // Every host under the competitor's registrable domain: the apex and its
  // asset and docs hosts belong to the same vendor as the configured product
  // subdomain, and labelling them differently was refused as inconsistent
  // (run C, 2026-09-13: cloudflare.com "institutional" beside
  // cf-assets.www.cloudflare.com "competitor" for workers.cloudflare.com).
  const configured = (args.configuredDomains ?? [])
    .map((raw) =>
      registrableDomain(
        normalizeDomain(raw)
          .toLowerCase()
          .replace(/^www\./, ''),
      ),
    )
    .filter(Boolean);

  for (const host of Object.keys(args.modelLabels)) {
    if (configured.some((domain) => hostMatchesDomain(host, domain))) {
      entries[host] = { category: 'competitor', source: 'config' };
    }
  }

  for (const domain of args.analyzerDomains) {
    entries[domain] = { category: 'competitor', source: 'analyzer' };
  }

  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => codepointCompare(a, b)),
  );

  return {
    version: domainClassifierVersion,
    model: args.model ?? domainModel,
    ...(args.contextHash ? { contextHash: args.contextHash } : {}),
    ...(args.modelProfileDigest
      ? { modelProfileDigest: args.modelProfileDigest }
      : {}),
    entries: sorted,
  };
};

// ---------------------------------------------------------------------------
// Model pass
// ---------------------------------------------------------------------------

const modelLabelSchema = z.object({
  results: z.array(
    z.object({
      domain: z.string().describe('The host exactly as given in the list'),
      category: z
        .enum(sourceCategories)
        .describe('competitor | social | institutional | earned (never owned)'),
    }),
  ),
});

export type DomainMarketContext = {
  brandName: string;
  brandDomain: string;
  productBrief: string;
  // The questions the run asked — they define the market the labels are
  // relative to.
  promptTexts: readonly string[];
};

const buildSystemPrompt = (context: DomainMarketContext): string => {
  return `You label the domains that AI assistants cited when answering buyer questions in one market. The client is ${context.brandName} (${context.brandDomain}).

Client brief:
${context.productBrief}

The questions the assistants answered:
${context.promptTexts.map((p) => `- ${p}`).join('\n')}

For each host, pick exactly one label:
- competitor: a company that sells the same kind of thing the client sells, to the same buyers — an agency, consultancy, vendor, or software tool competing for these answers. Include companies in the client's category even if smaller or adjacent.
- social: a community, forum, Q&A, video, social network, or blog-hosting platform where the content is user-generated (for example Substack, Hashnode, Zenn, Note, Quora, Product Hunt, Indie Hackers).
- institutional: an encyclopedia, standards body, government or academic site, analyst firm, or the official documentation or help center of a major platform (for example OpenAI, Anthropic, Google, Microsoft).
- earned: independent press, industry publications, newsletters, review and agency directories (G2, Clutch, Capterra), listicle sites, personal or company blogs that do not sell in this market, and anything else.

Judge from the host name and the sample paths; when unsure between competitor and earned, choose earned. Return every host exactly as given, once each. Never return "owned".

Rules the reviewers hold these labels to:
${producerGuidance('enrichment')
  .filter((line) => line.startsWith('ambiguous_source_classification'))
  .map((line) => `- ${line}`)
  .join('\n')}`;
};

const buildBatchPrompt = (hosts: readonly UnlabeledHost[]): string => {
  return `Label these ${hosts.length} hosts:

${hosts
  .map(
    (h) =>
      `- ${h.host}${h.competitorAllowed === false ? ' [contextual review excludes competitor; choose social, institutional, or earned]' : ''} (cited ${h.citations}×${
        h.samplePaths.length > 0 ? `; paths: ${h.samplePaths.join(', ')}` : ''
      })`,
  )
  .join('\n')}`;
};

const isRetryable = (error: unknown): boolean => {
  if (
    error instanceof ModelBudgetError ||
    (error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.startsWith('model_input_limit') ||
        error.message === 'model_output_limit'))
  ) {
    return false;
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;

    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  return true;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * acceptModelLabels validates one batch of model output: only hosts from the
 * batch, never "owned", one label per host. Hosts the model skipped stay
 * unlabeled (→ earned) and are reported so a systematic miss is visible.
 */
export const acceptModelLabels = (
  hosts: readonly UnlabeledHost[],
  results: ReadonlyArray<{ domain: string; category: SourceCategory }>,
): { labels: Record<string, SourceCategory>; missing: string[] } => {
  const expected = new Set(hosts.map((h) => h.host));
  const excluded = new Set(
    hosts
      .filter((host) => host.competitorAllowed === false)
      .map((host) => host.host),
  );
  const labels: Record<string, SourceCategory> = {};

  for (const result of results) {
    const host = modelHost(result.domain);

    if (!host || !expected.has(host)) {
      continue;
    }

    if (result.category === 'owned') {
      continue;
    }

    if (host in labels) {
      continue;
    }

    labels[host] =
      result.category === 'competitor' && excluded.has(host)
        ? 'earned'
        : result.category;
  }

  const missing = [...expected].filter((host) => !(host in labels));

  return { labels, missing };
};

// The model may echo a host as a URL (`https://foo.com/`); read the host
// out of it instead of dropping the label (§2.10).
const modelHost = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;

  try {
    return new URL(candidate).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

type LabelBatchOptions = {
  system: string;
  logContext: Record<string, unknown>;
  internalModels?: InternalModelContext;
  signal?: AbortSignal;
};

/** One call over some hosts, with the transport retry policy. Which hosts
 * it left unlabelled is the caller's concern: only it knows what is still
 * missing across rounds. */
const labelBatch = async (
  hosts: readonly UnlabeledHost[],
  { system, logContext, internalModels, signal }: LabelBatchOptions,
): Promise<Record<string, SourceCategory>> => {
  if (!internalModels) {
    throw new ModelBudgetError(
      'Uncached domain classification requires a pinned internal model profile and budget',
    );
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= domainTransientAttempts; attempt += 1) {
    try {
      const generated = await generateStructured(
        {
          roleName: 'domainClassifier',
          role: internalModels.profile.roles.domainClassifier,
          schema: modelLabelSchema,
          system,
          prompt: buildBatchPrompt(hosts),
          signal,
          accounting: internalModels.accounting,
        },
        internalModels.transport,
      );
      const { labels } = acceptModelLabels(hosts, generated.output.results);

      return labels;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;

      if (attempt < domainTransientAttempts && isRetryable(error)) {
        const delay = domainRetryDelaysMs[attempt - 1] ?? 8_000;
        log.warn('Domain label batch failed; retrying', {
          ...logContext,
          attempt,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export type LearnDomainLabelsResult = {
  file: DomainLabelsFile;
  learned: Record<string, SourceCategory>;
  stats: {
    analyzerDomains: number;
    modelLabelsReused: number;
    modelLabelsNew: number;
    // Hosts the model was asked about and did not label; they stay earned.
    modelSkipped: number;
    stillEarned: number;
  };
  // One entry per failed batch (already retried) and one per batch whose
  // output skipped hosts; the affected hosts stay earned.
  failures: string[];
};

/**
 * learnDomainLabels runs the full pass: analyzer domains → competitor, cached
 * model labels reused, the remaining hosts labeled by the model in batches.
 * Pure until the model call; nothing here touches the answer text.
 */
export const learnDomainLabels = async (args: {
  sections: readonly SectionVisibility[];
  staticConfig: SourceClassifierConfig;
  context: DomainMarketContext;
  previous: DomainLabelsFile | null;
  logContext?: Record<string, unknown>;
  internalModels?: InternalModelContext;
  signal?: AbortSignal;
}): Promise<LearnDomainLabelsResult> => {
  const analyzerDomains = analyzerBrandDomains(
    args.sections,
    args.staticConfig.brandDomain,
  );
  const contextHash = domainContextHash(args.context);
  const cached = reusableModelLabels(
    args.previous,
    args.internalModels,
    contextHash,
  );

  if (
    Object.keys(cached).length > 0 &&
    args.previous?.contextHash &&
    args.previous.contextHash !== contextHash
  ) {
    log.warn(
      'Reusing model labels judged in a different market context (brief or prompts changed); bump domainClassifierVersion to re-judge them',
      { ...args.logContext, reused: Object.keys(cached).length },
    );
  }

  // Hosts neither the static rules nor the analyzer explain.
  const afterAnalyzer: SourceClassifierConfig = {
    ...args.staticConfig,
    learned: Object.fromEntries(
      analyzerDomains.map((d) => [d, 'competitor' as const]),
    ),
  };
  const unlabeled = collectUnlabeledHosts(args.sections, afterAnalyzer);
  const reused: Record<string, SourceCategory> = {};
  const toLabel: UnlabeledHost[] = [];

  for (const entry of unlabeled) {
    const hit = cached[entry.host];

    if (hit) {
      reused[entry.host] = hit;
    } else {
      toLabel.push(entry);
    }
  }

  const fresh: Record<string, SourceCategory> = {};
  const failures: string[] = [];
  let modelSkipped = 0;

  if (toLabel.length > 0) {
    const system = buildSystemPrompt(args.context);
    const batches = args.internalModels
      ? batchModelInputs({
          items: toLabel,
          role: args.internalModels.profile.roles.domainClassifier,
          schema: modelLabelSchema,
          system,
          prompt: buildBatchPrompt,
          maxItems: domainBatchSize,
        })
      : Array.from(
          { length: Math.ceil(toLabel.length / domainBatchSize) },
          (_, index) => ({
            start: index * domainBatchSize,
            items: toLabel.slice(
              index * domainBatchSize,
              (index + 1) * domainBatchSize,
            ),
          }),
        );

    for (const [batchIndex, { items: batch }] of batches.entries()) {
      const logContext = {
        ...args.logContext,
        batchIndex,
        hosts: batch.length,
      };
      // An unlabelled host does not stay unlabelled quietly: it falls
      // through to `earned`, and earned domains are what the report
      // recommends to the client as outreach targets. Ask again for the
      // ones a call skipped before letting that default stand. Labels are
      // assigned as each round settles, so a batch abandoned in a later
      // round keeps what its earlier rounds learned.
      const labelled = new Map<number, SourceCategory>();

      try {
        const { pending, rounds } = await askUntilCovered({
          items: batch,
          answered: labelled,
          maxRounds: domainCoverageRounds,
          ask: async (pendingHosts, round) => {
            const labels = await labelBatch(
              pendingHosts.map((entry) => entry.item),
              {
                system,
                logContext: {
                  ...logContext,
                  round,
                  hosts: pendingHosts.length,
                },
                internalModels: args.internalModels,
                signal: args.signal,
              },
            );
            const answered: Array<readonly [number, SourceCategory]> = [];

            for (const { index, item } of pendingHosts) {
              const label = labels[item.host];

              if (!label) {
                continue;
              }

              fresh[item.host] = label;
              answered.push([index, label]);
            }

            return { answered };
          },
        });

        if (pending.length > 0) {
          const skipped = pending.flatMap((index) => batch[index]?.host ?? []);
          modelSkipped += skipped.length;
          log.warn('Model skipped hosts; they stay earned', {
            ...logContext,
            rounds,
            missing: skipped.length,
            sample: skipped.slice(0, 5),
          });
          failures.push(
            `batch ${batchIndex}: model skipped ${skipped.length} of ${batch.length} hosts (${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}); they stay earned`,
          );
        }
      } catch (error) {
        args.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const unlabelled = batch.length - labelled.size;
        failures.push(
          `batch ${batchIndex} (${unlabelled} of ${batch.length} hosts unlabelled) failed after retries: ${message}`,
        );
        log.warn('Domain label batch abandoned; unlabelled hosts stay earned', {
          ...logContext,
          labelled: labelled.size,
          unlabelled,
          error: message,
        });
      }
    }
  }

  // Model labels that came out "earned" are still worth recording: the
  // next run then knows the host was judged, not skipped. Every cached
  // label is written back, cited in this run or not (§2.7).
  const modelLabels = { ...cached, ...reused, ...fresh };
  const file = buildDomainLabelsFile({
    analyzerDomains,
    configuredDomains: args.staticConfig.competitorDomains,
    modelLabels,
    model: args.internalModels?.profile.roles.domainClassifier.model,
    contextHash,
    modelProfileDigest: args.internalModels
      ? internalModelRoleDigest(
          args.internalModels.profile.roles.domainClassifier,
        )
      : undefined,
  });
  const learned = learnedLabels(file);
  const stillEarned = collectUnlabeledHosts(args.sections, {
    ...args.staticConfig,
    learned,
  }).length;

  log.info('Domain labels learned', {
    ...args.logContext,
    analyzerDomains: analyzerDomains.length,
    modelLabelsReused: Object.keys(reused).length,
    modelLabelsNew: Object.keys(fresh).length,
    modelSkipped,
    stillEarned,
    failures: failures.length,
  });

  return {
    file,
    learned,
    stats: {
      analyzerDomains: analyzerDomains.length,
      modelLabelsReused: Object.keys(reused).length,
      modelLabelsNew: Object.keys(fresh).length,
      modelSkipped,
      stillEarned,
    },
    failures,
  };
};

const urlPath = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);

    if (pathname === '/' || pathname === '') {
      return null;
    }

    return pathname.length > 60 ? `${pathname.slice(0, 57)}...` : pathname;
  } catch {
    return null;
  }
};
