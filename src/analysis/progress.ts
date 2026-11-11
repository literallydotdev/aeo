import type { AeoAuditConfig, AeoSnapshot } from '../schema';
import {
  capturePlan,
  validateCaptureManifest,
  type CaptureManifest,
} from '../capture-manifest';
import { plannedProbeUnitsForSection, type ProbeUnit } from '../lib/checkpoint';
import {
  progressSlotKey,
  type ProgressMeasurement,
  type ProgressSlot,
} from '../lib/progress-comparison';
import { isSurfaceSinceProgressVersion1 } from '../report/core/progress-schema';
import { contentHash } from '../stores/content-hash';
import { normalizeDomain } from './scoring';
import { isDomainCited } from './domain-match';

export type ProgressMeasurementInput = {
  runId: string;
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  captureManifest?: unknown;
  publishedAt?: string | null;
};

const date = (value: string | null | undefined): string | null => {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return null;
  }

  return new Date(value).toISOString();
};

const questionKey = (text: string): string => {
  // Exact text, deliberately independent of changing IDs or array order.
  return contentHash(text);
};

const key = (
  unit: Pick<ProbeUnit, 'sectionKey' | 'promptText' | 'surface' | 'runIndex'>,
): string => {
  return progressSlotKey({
    ...unit,
    questionKey: questionKey(unit.promptText),
  });
};

/**
 * projectProgressMeasurement is called on the server before passing history
 * into the report's client island. The manifest remains private; only
 * counts/flags and opaque identities leave.
 */
export const projectProgressMeasurement = (
  input: ProgressMeasurementInput,
): ProgressMeasurement => {
  const { runId, config, snapshot } = input;
  const warnings = new Set<ProgressMeasurement['warnings'][number]>();
  let state: ProgressMeasurement['state'] = 'independent';
  let manifest: CaptureManifest | undefined;

  if (input.captureManifest !== undefined && input.captureManifest !== null) {
    try {
      manifest = validateCaptureManifest(input.captureManifest, {
        reportKey: config.reportKey,
        runId,
      });
    } catch {
      state = 'invalid';
      warnings.add('invalid_capture_manifest');
    }
  } else {
    state = 'legacy';
    warnings.add('historical_capture_metadata_unknown');
  }

  if (
    snapshot.reportKey !== config.reportKey ||
    (snapshot.meta.runId && snapshot.meta.runId !== runId)
  ) {
    state = 'invalid';
    warnings.add('artifact_identity_mismatch');
  }

  if (
    snapshot.meta.derivedFromRunId ||
    snapshot.meta.replayKind ||
    manifest?.derivedFromRunId
  ) {
    state = 'derived';
  }

  const configured = new Map(
    config.sections.map((section) => [section.key, section]),
  );
  const surfaces = snapshot.meta.surfaces ?? [
    ...new Set(
      snapshot.sections.flatMap((section) => section.visibility.surfaces),
    ),
  ];

  if (
    manifest &&
    capturePlan(config, surfaces, [
      ...new Set(manifest.plan.units.map((unit) => unit.sectionKey)),
    ]).configDigest !== manifest.plan.configDigest
  ) {
    state = 'invalid';
    warnings.add('plan_config_mismatch');
  }

  const units =
    manifest?.plan.units ??
    config.sections.flatMap((section) =>
      plannedProbeUnitsForSection({
        sectionKey: section.key,
        prompts: section.prompts,
        surfaces,
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
      }),
    );
  const planned = new Map<string, ProbeUnit>();

  for (const unit of units) {
    const section = configured.get(unit.sectionKey);

    if (!section?.prompts.some((prompt) => prompt.text === unit.promptText)) {
      state = 'invalid';
      warnings.add('plan_config_mismatch');
    }

    if (planned.has(key(unit))) {
      state = 'invalid';
      warnings.add('duplicate_planned_slots');
    }

    planned.set(key(unit), unit);
  }

  const captures = new Map(
    manifest?.captures.map((capture) => [key(capture), capture]) ?? [],
  );
  const outcomes = new Map<
    string,
    AeoSnapshot['sections'][number]['visibility']['matrix'][number]
  >();

  for (const section of snapshot.sections) {
    for (const row of section.visibility.matrix) {
      const text = section.visibility.prompts[row.promptIdx]?.text;

      if (text === undefined) {
        state = 'invalid';
        warnings.add('matrix_question_missing');
        continue;
      }

      // Older rows may omit runIndex. Infer only when there is exactly one
      // planned repetition for this exact question and surface.
      const matching =
        row.runIndex === undefined
          ? units.filter(
              (unit) =>
                unit.sectionKey === section.key &&
                unit.promptText === text &&
                unit.surface === row.surface,
            )
          : [];
      const runIndex =
        row.runIndex ??
        (matching.length === 1 ? matching[0]?.runIndex : undefined);

      if (runIndex === undefined) {
        warnings.add('historical_run_index_unknown');
        continue;
      }

      const rowKey = key({
        sectionKey: section.key,
        promptText: text,
        surface: row.surface,
        runIndex,
      });

      if (!planned.has(rowKey) || outcomes.has(rowKey)) {
        state = 'invalid';
        warnings.add('matrix_plan_mismatch');
        continue;
      }

      outcomes.set(rowKey, row);
    }
  }

  const slots: ProgressSlot[] = [...planned].map(([slotKey, unit]) => {
    const capture = captures.get(slotKey);
    const row = outcomes.get(slotKey);
    const noOverview =
      capture?.noOverview === true || (!manifest && row?.noOverview === true);
    const captured = manifest
      ? !!capture && (capture.hasEvidence || noOverview)
      : !!row;
    const analyzed = captured && (noOverview || !!row);
    const citationObserved = captured && (noOverview || !!row?.citedUrls);
    const requestedModel = capture?.probeProfile.requestedModel ?? null;
    const reportedModel = capture?.probeProfile.reportedModel ?? null;
    const cliVersion =
      capture?.probeProfile.cliVersion ?? row?.agentCliVersion ?? null;
    const parameters = capture?.probeProfile.parameters ?? null;
    // Hashed exactly when recorded: a capture without it was taken with its
    // surface's legacy adapter, and digests as earlier releases did.
    const adapter = capture?.probeProfile.adapter;
    const hasParameters =
      parameters !== null && Object.keys(parameters).length > 0;
    // Empty strings carry no metadata, so these checks are truthiness checks.
    const collectionMetadataKnown =
      Boolean(requestedModel) ||
      Boolean(reportedModel) ||
      Boolean(cliVersion) ||
      hasParameters;

    if (captured && !collectionMetadataKnown) {
      warnings.add('collection_metadata_unknown');
    }

    return {
      sectionKey: unit.sectionKey,
      questionKey: questionKey(unit.promptText),
      surface: unit.surface,
      runIndex: unit.runIndex,
      captured,
      analyzed,
      citationObserved,
      captureId:
        capture && captured
          ? contentHash({
              slot: slotKey,
              capturedAt: capture.capturedAt,
              rawDigest: capture.rawDigest,
            })
          : null,
      mentioned: analyzed && !noOverview && row?.prospectMentioned === true,
      cited:
        citationObserved &&
        !noOverview &&
        isDomainCited(row?.citedUrls ?? [], config.brand.domain),
      requestedModel,
      cliVersion,
      collectionMetadataKnown,
      collectionMethodDigest: collectionMetadataKnown
        ? contentHash({
            requestedModel,
            reportedModel,
            cliVersion,
            parameters,
            ...(adapter === undefined ? {} : { adapter }),
          })
        : null,
    };
  });
  const dates =
    manifest?.captures
      .map((capture) => date(capture.capturedAt))
      .filter((value): value is string => value !== null)
      .sort() ?? [];
  const knownFresh =
    manifest?.captures.filter(
      (capture) => capture.originRunId === runId && date(capture.capturedAt),
    ).length ?? 0;
  const knownReused =
    manifest?.captures.filter(
      (capture) =>
        capture.originRunId !== null && capture.originRunId !== runId,
    ).length ??
    snapshot.meta.reusedProbes?.count ??
    0;
  const unknown =
    manifest?.captures.filter(
      (capture) =>
        capture.originRunId === null || date(capture.capturedAt) === null,
    ).length ?? 0;

  if (!['invalid', 'derived'].includes(state)) {
    if (manifest?.captures.length && knownReused === manifest.captures.length) {
      state = 'reused';
    } else if (knownReused > 0 && knownFresh > 0) {
      state = 'mixed';
    } else if (unknown > 0 || !manifest?.captures.length) {
      state = 'legacy';
    }

    // Old snapshots can establish complete reuse even without a manifest.
    if (
      !manifest &&
      snapshot.meta.reusedProbes?.count &&
      snapshot.meta.reusedProbes.count >= snapshot.meta.probeCount
    ) {
      state = 'reused';
    }
  }

  if (unknown > 0 || dates.length !== (manifest?.captures.length ?? 0)) {
    warnings.add('historical_capture_metadata_unknown');
  }

  if (state === 'mixed') {
    warnings.add('includes_reused_captures');
  }

  if (state === 'reused') {
    warnings.add('reused_measurement');
  }

  if (state === 'derived') {
    warnings.add('analysis_replay');
  }

  return {
    version: slots.some((slot) => isSurfaceSinceProgressVersion1(slot.surface))
      ? 2
      : 1,
    runId,
    ...(config.questionSetName
      ? { questionSetName: config.questionSetName }
      : {}),
    publishedAt: date(input.publishedAt),
    captureWindow: { start: dates[0] ?? null, end: dates.at(-1) ?? null },
    measurementId: manifest
      ? contentHash(
          manifest.captures
            .map((capture) => ({
              slot: key(capture),
              capturedAt: capture.capturedAt,
              rawDigest: capture.rawDigest,
            }))
            .sort((left, right) => left.slot.localeCompare(right.slot)),
        )
      : null,
    state,
    warnings: [...warnings],
    reusedCaptures: knownReused,
    brandIdentity: contentHash({
      domain: normalizeDomain(config.brand.domain),
      name: config.brand.name.trim().toLowerCase(),
      aliases: [
        ...new Set(
          config.brand.aliases.map((alias) => alias.trim().toLowerCase()),
        ),
      ].sort(),
    }),
    geography: config.geography.trim().toLowerCase(),
    language: config.language.trim().toLowerCase(),
    analyzer: {
      version: snapshot.meta.analyzerVersion ?? null,
      model: snapshot.meta.models?.analyzer ?? null,
    },
    slots,
  };
};
