import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json';
import { isDomainCited } from '../analysis/domain-match';
import { plannedProbeUnitsForSection } from '../lib/checkpoint';
import type { AeoAuditConfig, AeoSnapshot } from '../schema';
import type {
  ClaimAssessment,
  ClaimCandidate,
  GroundingBundle,
  GroundingSource,
  ProductFact,
  SourceReference,
} from '../grounding/schema';
import { validateGroundingBundle } from '../grounding/validation';
import { buildNarrativeFacts } from './narrative-facts';

// 3: the chat surfaces' labels say "(API)" (method release spec §4.3), and
// they enter the captured-surfaces sentence.
export const factCatalogVersion = 3;

type FactBase = {
  factId: string;
  runId: string;
  section: string | null;
  surface: string | null;
  entity: string;
  metric: string;
  numerator: number | null;
  denominator: number | null;
  unit: 'planned_answers' | 'captured_answers' | 'check' | 'count';
  sentence: string;
};

export type ReportFact = FactBase &
  (
    | { kind: 'measurement' }
    | {
        kind: 'observed_claim';
        candidate: ClaimCandidate;
        groundingDigest: string;
      }
    | {
        kind: 'assessment';
        candidate: ClaimCandidate;
        assessment: Exclude<ClaimAssessment, { verdict: 'unresolved' }>;
        sources: GroundingSource[];
        groundingDigest: string;
      }
    | {
        kind: 'product_fact';
        productFact: ProductFact;
        sources: GroundingSource[];
        groundingDigest: string;
      }
  );

export type FactCatalog = {
  version: number;
  runId: string;
  facts: ReportFact[];
};

export type WriterFactCatalog = {
  facts: (Pick<ReportFact, 'factId' | 'section' | 'sentence'> &
    (
      | { kind: 'assessment'; assessmentId: string }
      | { kind: Exclude<ReportFact['kind'], 'assessment'> }
    ))[];
} & Pick<FactCatalog, 'version' | 'runId'>;

/**
 * projectWriterFactCatalog projects the catalog for writers. Writers select
 * complete scoped sentences. Full source passages remain in the host catalog
 * for premise verification, without repeating them in generation.
 */
export const projectWriterFactCatalog = (
  catalog: FactCatalog,
): WriterFactCatalog => {
  return {
    version: catalog.version,
    runId: catalog.runId,
    facts: catalog.facts.map((fact) => {
      const base = {
        factId: fact.factId,
        section: fact.section,
        sentence: fact.sentence,
      };

      return fact.kind === 'assessment'
        ? { ...base, kind: fact.kind, assessmentId: fact.assessment.claimId }
        : { ...base, kind: fact.kind };
    }),
  };
};

export type BuildFactCatalogOptions = {
  snapshot: AeoSnapshot;
  config: AeoAuditConfig;
  runId: string;
  grounding?: GroundingBundle;
};

/** Only adapter-owned observations enter this catalog. Suspected claims never do. */
export const buildFactCatalog = ({
  snapshot,
  config,
  runId,
  grounding,
}: BuildFactCatalogOptions): FactCatalog => {
  if (
    snapshot.reportKey !== config.reportKey ||
    (snapshot.meta.runId && snapshot.meta.runId !== runId)
  ) {
    throw new Error(
      `Snapshot does not belong to the pinned run or config: ${snapshot.reportKey}, run ${runId}.`,
    );
  }

  const facts: ReportFact[] = [];

  for (const section of snapshot.sections) {
    const configured = config.sections.find(
      (entry) => entry.key === section.key,
    );

    if (!configured) {
      throw new Error(`Unknown snapshot section: ${section.key}.`);
    }

    for (const surface of section.visibility.surfaces) {
      const rows = section.visibility.matrix.filter(
        (row) => row.surface === surface,
      );
      const count = plannedProbeUnitsForSection({
        sectionKey: section.key,
        prompts: configured.prompts,
        surfaces: [surface],
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
      }).length;

      for (const metric of ['mentions', 'citations'] as const) {
        const numerator = rows.filter((row) =>
          metric === 'mentions'
            ? row.prospectMentioned
            : isDomainCited(row.citedUrls ?? [], config.brand.domain),
        ).length;
        const percent = Math.round((numerator / count) * 1000) / 10;
        facts.push({
          kind: 'measurement',
          factId: `${section.key}:${surface}:${metric}`,
          runId,
          section: section.key,
          surface,
          entity: config.brand.name,
          metric,
          numerator,
          denominator: count,
          unit: 'planned_answers',
          sentence: `For ${section.key.replaceAll('_', ' ')}, ${surface.replaceAll('_', ' ')} ${metric === 'mentions' ? 'mentioned' : 'cited'} ${config.brand.name} in ${numerator} of ${count} planned answers (${percent}%). ${rows.length} answers were captured; missing answers remain in the denominator.`,
        });
      }
    }
  }

  for (const bot of snapshot.technicalChecks?.crawlerAccess?.bots ?? []) {
    if (bot.robotsAllowed === null) {
      continue;
    }

    facts.push({
      kind: 'measurement',
      factId: `technical:robots:${bot.bot}`,
      runId,
      section: null,
      surface: null,
      entity: config.brand.name,
      metric: 'robots_access',
      numerator: null,
      denominator: null,
      unit: 'check',
      sentence: `The robots.txt check ${bot.robotsAllowed ? 'allowed' : 'blocked'} ${bot.bot} at the time of this audit. This check does not establish whether the provider used the site.`,
    });
  }

  facts.push({
    kind: 'measurement',
    factId: 'aggregate:captured',
    runId,
    section: null,
    surface: null,
    entity: config.brand.name,
    metric: 'captured_answers',
    numerator: snapshot.meta.probeCount,
    denominator: null,
    unit: 'count',
    sentence: `This audit captured ${snapshot.meta.probeCount} answers across the measured sections and surfaces.`,
  });
  facts.push(...buildNarrativeFacts(snapshot, config, runId));

  if (grounding) {
    const bundle = validateGroundingBundle(grounding, {
      reportKey: config.reportKey,
      runId,
    });
    const base = {
      runId,
      numerator: null,
      denominator: null,
      unit: 'check' as const,
      surface: null,
      entity: config.brand.name,
    };
    const selectedSources = (references: SourceReference[]) => {
      return bundle.sources
        .filter((source) =>
          references.some((reference) => reference.sourceId === source.id),
        )
        .map((source) => ({
          ...source,
          passages: source.passages.filter((passage) =>
            references.some(
              (reference) =>
                reference.sourceId === source.id &&
                reference.passageId === passage.id,
            ),
          ),
        }));
    };

    for (const productFact of bundle.facts) {
      if (productFact.status !== 'supported') {
        continue;
      }

      facts.push({
        ...base,
        kind: 'product_fact',
        factId: `product:${productFact.id}`,
        section: null,
        metric: 'sourced_product_fact',
        productFact,
        sources: selectedSources(productFact.references),
        groundingDigest: bundle.digest,
        sentence: `For ${describeScope(productFact.scope)}, the captured source evidence supports: ${productFact.proposition}`,
      });
    }

    for (const candidate of bundle.candidates) {
      const assessment = bundle.assessments.find(
        (entry) => entry.claimId === candidate.id,
      );

      // Unresolved and overflow candidates stay private; they cannot be bases.
      if (!assessment || assessment.verdict === 'unresolved') {
        continue;
      }

      const sections = [
        ...new Set(
          candidate.occurrences.map((occurrence) => occurrence.section),
        ),
      ];
      const section = sections.length === 1 ? (sections[0] ?? null) : null;
      facts.push({
        ...base,
        kind: 'observed_claim',
        factId: `claim:${candidate.id}`,
        section,
        metric: 'observed_answer_claim',
        candidate,
        groundingDigest: bundle.digest,
        sentence: `A captured answer made this claim about ${describeScope(candidate.scope)}: ${candidate.proposition} This observation alone does not establish whether the claim is true.`,
      });
      facts.push({
        ...base,
        kind: 'assessment',
        factId: `assessment:${candidate.id}`,
        section,
        metric: 'sourced_claim_assessment',
        candidate,
        assessment,
        sources: selectedSources(assessment.references),
        groundingDigest: bundle.digest,
        sentence:
          assessment.verdict === 'supported'
            ? `For ${describeScope(candidate.scope)}, the captured sources support this answer claim: ${candidate.proposition}`
            : `For ${describeScope(candidate.scope)}, a captured answer claimed: ${candidate.proposition} The captured sources instead support: ${assessment.incompatibleProposition}`,
      });
    }
  }

  return { version: factCatalogVersion, runId, facts };
};

const describeScope = (scope: ProductFact['scope']): string => {
  return [
    scope.product,
    scope.generation,
    scope.version,
    scope.applicableAt
      ? `as of ${scope.applicableAt}`
      : 'with time scope unspecified',
  ]
    .filter(Boolean)
    .join(', ');
};

export const factFingerprint = (fact: ReportFact): string => {
  const { runId: _runId, ...observation } = fact;

  return createHash('sha256').update(canonicalJson(observation)).digest('hex');
};

/**
 * methodologyNote composes the methodology block. This block is composed after
 * generation and cannot be removed by the model.
 */
export const methodologyNote = (snapshot: AeoSnapshot): string => {
  const meta = snapshot.meta;
  const surfaces = meta.surfaces ?? [
    ...new Set(
      snapshot.sections.flatMap((section) => section.visibility.surfaces),
    ),
  ];
  const migrationList =
    meta.migrations
      ?.map((migration) => `${migration.id} (${migration.appliedAt})`)
      .join(', ') ?? '';
  const parts = [
    `Measured surfaces: ${surfaces.map((surface) => surface.replaceAll('_', ' ')).join(', ')}.`,
    `Models: analyzer ${meta.models?.analyzer ?? 'not recorded'}; perception ${meta.models?.perception ?? 'not recorded'}.`,
    `Answer analyzer version: ${meta.analyzerVersion ?? 'not recorded'}. Domain classifier version: ${meta.domainClassifierVersion ?? 'not recorded'}.`,
    `Data migrations: ${migrationList === '' ? 'none recorded' : migrationList}.`,
    `Reused probes: ${meta.reusedProbes?.count ?? 0}${meta.reusedProbes?.oldestCapturedAt ? `; oldest capture ${meta.reusedProbes.oldestCapturedAt}` : ''}.`,
    `Partial failures: ${meta.partialFailures.length}${meta.partialFailures.length ? ` (${meta.partialFailures.map((failure) => failure.step).join(', ')})` : ''}.`,
  ];
  // Historical versions use the same conservative description; a future
  // methodology change can add a versioned template here without model input.
  parts.push(
    'Citations count explicit references to the brand domain in the captured answer and its structured citations. Mentions and citations are separate measures.',
  );

  return parts.join(' ');
};
