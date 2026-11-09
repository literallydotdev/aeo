import { z } from 'zod';
import {
  aeoSurfaceSchema,
  retrievalLogSchema,
  citationAttributionSchema,
  type AeoAuditConfig,
  type AeoEvidenceChunk,
  type AeoSurface,
} from './schema';
import { plannedProbeUnitsForSection, unitRecordKey } from './lib/checkpoint';
import { normalizeResponseText } from './analysis/answer-text';
import type { CapturedUnitRecord } from './stores/ports';
import type { SavedAnswer } from './grounding/schema';
import { contentHash } from './stores/content-hash';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unitSchema = z.object({
  sectionKey: z.string(),
  promptId: z.string(),
  promptText: z.string(),
  surface: aeoSurfaceSchema,
  runIndex: z.number().int(),
});

const captureSchema = unitSchema
  .extend({
    id: z.string().min(1),
    promptIdx: z.number().int().nonnegative(),
    promptDigest: digest,
    originRunId: z.string().nullable(),
    capturedAt: z.string().datetime().nullable(),
    rawText: z.string(),
    rawDigest: digest,
    text: z.string(),
    answerDigest: digest,
    hasEvidence: z.boolean(),
    noOverview: z.boolean(),
    retrieval: retrievalLogSchema.optional(),
    retrievalDigest: digest,
    citationAttribution: citationAttributionSchema.optional(),
    probeProfile: z.object({
      requestedModel: z.string().nullable(),
      reportedModel: z.string().nullable(),
      cliVersion: z.string().nullable(),
      parameters: z.record(z.string(), z.unknown()).nullable(),
      // Present only when the capture was not taken with its surface's
      // legacy adapter (probe adapters spec §4.6).
      adapter: z.string().optional(),
    }),
    metadataProvenance: z.enum(['captured_record', 'legacy_preserved_record']),
    digest,
  })
  .strict();

export const captureManifestSchema = z
  .object({
    version: z.literal(1),
    reportKey: z.string().min(1),
    runId: z.string().min(1),
    createdAt: z.string().datetime(),
    derivedFromRunId: z.string().optional(),
    plan: z.object({
      configDigest: digest,
      units: z.array(unitSchema),
      digest,
    }),
    captures: z.array(captureSchema),
    digest,
  })
  .strict();

export type CaptureManifest = z.infer<typeof captureManifestSchema>;
const withoutDigest = (value: { digest: string }): string => {
  const { digest: _digest, ...rest } = value;

  return contentHash(rest);
};

export const capturePlan = (
  config: AeoAuditConfig,
  surfaces: readonly AeoSurface[],
  sections?: readonly string[],
) => {
  const selected = config.sections.filter(
    (section) => !sections || sections.includes(section.key),
  );

  const configDigest = contentHash({
    brand: config.brand,
    competitors: config.competitors,
    sections: selected.map((section) => ({
      key: section.key,
      prompts: section.prompts,
      competitors: section.competitors,
    })),
    geography: config.geography,
    language: config.language,
    agentProbes: config.agentProbes,
    // Undefined members are dropped, so a config without chat depth keeps
    // the digest earlier releases gave it.
    chatProbes: config.chatProbes,
    surfaces,
  });

  const plan = {
    configDigest,
    units: selected.flatMap((section) =>
      plannedProbeUnitsForSection({
        sectionKey: section.key,
        prompts: section.prompts,
        surfaces,
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
      }),
    ),
  };

  return { ...plan, digest: contentHash(plan) };
};

export const validateCaptureManifest = (
  value: unknown,
  expected?: { reportKey: string; runId: string; chunks?: AeoEvidenceChunk[] },
): CaptureManifest => {
  const manifest = captureManifestSchema.parse(value);

  if (
    withoutDigest(manifest) !== manifest.digest ||
    withoutDigest(manifest.plan) !== manifest.plan.digest ||
    new Set(manifest.captures.map((c) => c.id)).size !==
      manifest.captures.length
  ) {
    throw new Error('Invalid capture manifest identity or digest.');
  }

  const planned = new Set(manifest.plan.units.map(unitRecordKey));

  for (const c of manifest.captures) {
    if (
      !planned.has(unitRecordKey(c)) ||
      c.id !== unitRecordKey(c) ||
      withoutDigest(c) !== c.digest ||
      contentHash(c.rawText) !== c.rawDigest ||
      contentHash(c.text) !== c.answerDigest ||
      (normalizeResponseText(c.rawText) ?? '') !== c.text ||
      contentHash(c.promptText) !== c.promptDigest ||
      contentHash(c.retrieval ?? null) !== c.retrievalDigest
    ) {
      throw new Error('Immutable capture identity or content mismatch.');
    }
  }

  if (expected) {
    if (
      manifest.reportKey !== expected.reportKey ||
      manifest.runId !== expected.runId
    ) {
      throw new Error('Capture manifest belongs to another run.');
    }

    if (expected.chunks) {
      const records = expected.chunks.flatMap((chunk) =>
        chunk.runs.map((run) => ({
          sectionKey: chunk.sectionKey,
          promptIdx: chunk.promptIdx,
          promptText: chunk.promptText,
          surface: run.surface,
          runIndex: run.runIndex,
          text: run.responseText,
          retrieval: run.retrieval,
          citationAttribution: run.citationAttribution,
        })),
      );

      const captures = manifest.captures
        .filter((c) => c.hasEvidence)
        .map((c) => ({
          sectionKey: c.sectionKey,
          promptIdx: c.promptIdx,
          promptText: c.promptText,
          surface: c.surface,
          runIndex: c.runIndex,
          text: c.text,
          retrieval: c.retrieval,
          citationAttribution: c.citationAttribution,
        }));

      const sortedHashes = (items: unknown[]) => {
        return items.map(contentHash).sort();
      };

      if (
        contentHash(sortedHashes(records)) !==
        contentHash(sortedHashes(captures))
      ) {
        throw new Error('Capture manifest does not match saved evidence.');
      }
    }
  }

  return manifest;
};

/** No fields are recovered from a mutable checkpoint unless its exact answer and retrieval match. */
export const buildCaptureManifest = (args: {
  reportKey: string;
  runId: string;
  createdAt: string;
  config: AeoAuditConfig;
  chunks: AeoEvidenceChunk[];
  records: CapturedUnitRecord[];
  surfaces: readonly AeoSurface[];
  sections?: readonly string[];
}): CaptureManifest => {
  const plan = capturePlan(args.config, args.surfaces, args.sections);
  const records = new Map(
    args.records.map((record) => [unitRecordKey(record), record]),
  );

  const captures = plan.units.flatMap((unit) => {
    const record = records.get(unitRecordKey(unit));

    if (!record) {
      return [];
    }

    const section = args.config.sections.find((s) => s.key === unit.sectionKey);

    if (!section) {
      throw new Error(
        `Capture plan unit references unknown section: ${unit.sectionKey}.`,
      );
    }

    const promptIdx = section.prompts.findIndex(
      (prompt) => prompt.id === unit.promptId,
    );

    const chunk = args.chunks.find(
      (c) => c.sectionKey === unit.sectionKey && c.promptIdx === promptIdx,
    );

    const evidence = chunk?.runs.find(
      (run) => run.surface === unit.surface && run.runIndex === unit.runIndex,
    );

    const text = normalizeResponseText(record.probe.text) ?? '';

    if (
      evidence &&
      (text !== evidence.responseText ||
        contentHash(record.probe.retrieval ?? null) !==
          contentHash(evidence.retrieval ?? null))
    ) {
      throw new Error('Preserved capture differs from immutable evidence.');
    }

    const capture = {
      ...unit,
      id: unitRecordKey(unit),
      promptIdx,
      promptDigest: contentHash(unit.promptText),
      originRunId: record.runId ?? null,
      capturedAt: record.capturedAt,
      rawText: record.probe.text,
      rawDigest: contentHash(record.probe.text),
      text,
      answerDigest: contentHash(text),
      hasEvidence: !!evidence,
      noOverview:
        'noOverview' in record.probe && record.probe.noOverview === true,
      retrieval: record.probe.retrieval,
      retrievalDigest: contentHash(record.probe.retrieval ?? null),
      citationAttribution: evidence?.citationAttribution,
      probeProfile: {
        requestedModel: record.captureMetadata?.requestedModel ?? null,
        reportedModel: record.captureMetadata?.reportedModel ?? null,
        cliVersion:
          'agentCliVersion' in record.probe
            ? record.probe.agentCliVersion
            : null,
        parameters: record.captureMetadata?.parameters ?? null,
        ...(record.captureMetadata?.adapter === undefined
          ? {}
          : { adapter: record.captureMetadata.adapter }),
      },
      metadataProvenance: record.captureMetadata
        ? ('captured_record' as const)
        : ('legacy_preserved_record' as const),
    };

    return [{ ...capture, digest: contentHash(capture) }];
  });

  const manifest = {
    version: 1 as const,
    reportKey: args.reportKey,
    runId: args.runId,
    createdAt: args.createdAt,
    plan,
    captures,
  };

  return validateCaptureManifest(
    { ...manifest, digest: contentHash(manifest) },
    args,
  );
};

export const deriveCaptureManifest = (
  source: CaptureManifest,
  runId: string,
  createdAt: string,
): CaptureManifest => {
  validateCaptureManifest(source);
  const { digest: _digest, ...rest } = source;
  const derived = { ...rest, runId, createdAt, derivedFromRunId: source.runId };

  return validateCaptureManifest({ ...derived, digest: contentHash(derived) });
};

export const savedAnswersFromManifest = (
  manifest: CaptureManifest,
): SavedAnswer[] => {
  validateCaptureManifest(manifest);

  return manifest.captures
    .filter((c) => c.text.length > 0)
    .map((capture) => ({
      id: capture.id,
      runId: manifest.runId,
      section: capture.sectionKey,
      promptId: capture.promptId,
      surface: capture.surface,
      runIndex: capture.runIndex,
      capturedAt: capture.capturedAt,
      text: capture.text,
      digest: capture.answerDigest,
    }));
};

/** Legacy extraction keys included the processing run. Only a validated,
 * dated capture can prove an earlier run identity for that exact answer. */
export const extractionCacheRunIdsFromManifest = (
  manifest: CaptureManifest,
): Readonly<Record<string, string>> => {
  const validated = validateCaptureManifest(manifest);

  return Object.fromEntries(
    validated.captures.flatMap((capture) =>
      capture.text.length > 0 &&
      capture.capturedAt !== null &&
      capture.originRunId
        ? [[capture.id, capture.originRunId]]
        : [],
    ),
  );
};
