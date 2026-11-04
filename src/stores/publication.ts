import {
  assertCopyValidation,
  copyCheckerVersion,
} from '../agents/copy-validation';
import { internalModelProfileSchema } from '../models/profiles';
import { aeoSnapshotSchema } from '../schema';
import type { ConfigVersion, CopyVersion } from './versions';
import { StoreConflictError } from './versions';

export type PublicationTriple = {
  reportKey: string;
  runId: string;
  configVersion: number;
  copyVersion: number;
};

export type PublishReceipt = {
  checkerVersion: number;
  valid: true;
  approvedBy: string;
} & PublicationTriple;

export const sameTriple = (
  actual: unknown,
  expected: PublicationTriple,
): boolean => {
  if (typeof actual !== 'object' || actual === null) {
    return false;
  }

  const isSame =
    'reportKey' in actual &&
    actual.reportKey === expected.reportKey &&
    'runId' in actual &&
    actual.runId === expected.runId &&
    'configVersion' in actual &&
    actual.configVersion === expected.configVersion &&
    'copyVersion' in actual &&
    actual.copyVersion === expected.copyVersion;

  return isSame;
};

type PublishableRun = {
  reportKey: string;
  status: string;
  configVersion?: number | null;
  request?: unknown;
  deletedAt?: Date | string | null;
};

type PublishableArtifact = {
  configVersion?: number | null;
  fullScope: boolean;
  snapshot?: unknown;
  grounding?: unknown;
};

type PublishableConfig = Pick<
  ConfigVersion,
  'reportKey' | 'version' | 'status' | 'config'
>;

type PublishableCopy = Pick<
  CopyVersion,
  | 'reportKey'
  | 'version'
  | 'status'
  | 'basisRunId'
  | 'source'
  | 'copy'
  | 'provenance'
  | 'validation'
>;

// The receipt is checked, not trusted: callers may hand over a stored one.
type ReceiptCandidate = Omit<PublishReceipt, 'valid'> & { valid: unknown };

export type PublishableOptions<
  TRun extends PublishableRun,
  TArtifact extends PublishableArtifact,
  TConfig extends PublishableConfig,
  TCopy extends PublishableCopy,
> = {
  triple: PublicationTriple;
  receipt: ReceiptCandidate;
  priorPublication?: PublicationTriple | null;
  run: TRun | null | undefined;
  artifact: TArtifact | null | undefined;
  config: TConfig | null | undefined;
  copy: TCopy | null | undefined;
};

const readModelProfile = (request: unknown): unknown => {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('modelProfile' in request)
  ) {
    return undefined;
  }

  return request.modelProfile;
};

/**
 * assertPublishable throws unless the triple may be published, and returns
 * the run, artifact, config and copy it proved present.
 */
export const assertPublishable = <
  TRun extends PublishableRun,
  TArtifact extends PublishableArtifact,
  TConfig extends PublishableConfig,
  TCopy extends PublishableCopy,
>(
  options: PublishableOptions<TRun, TArtifact, TConfig, TCopy>,
) => {
  const { triple, receipt, run, artifact, config, copy } = options;

  // Only the committed exact triple proves these superseded versions were
  // approved together. Rollback still revalidates its immutable source below.
  const restoringPublication = sameTriple(options.priorPublication, triple);

  if (
    !sameTriple(receipt, triple) ||
    receipt.checkerVersion !== copyCheckerVersion ||
    receipt.valid !== true ||
    typeof receipt.approvedBy !== 'string' ||
    !receipt.approvedBy.trim()
  ) {
    throw new StoreConflictError(
      'Publication requires current validation and approval of the exact run/config/copy triple',
    );
  }

  if (
    run?.reportKey !== triple.reportKey ||
    run.status !== 'completed' ||
    run.configVersion !== triple.configVersion ||
    !artifact?.fullScope ||
    artifact.configVersion !== triple.configVersion
  ) {
    throw new StoreConflictError(
      'Publication requires a completed, full-scope run of the selected config',
    );
  }

  if (run.deletedAt) {
    throw new StoreConflictError(
      `Please restore deleted run '${triple.runId}' before publishing it.`,
    );
  }

  if (
    !config ||
    !copy ||
    config.reportKey !== triple.reportKey ||
    copy.reportKey !== triple.reportKey ||
    config.version !== triple.configVersion ||
    copy.version !== triple.copyVersion ||
    (config.status !== 'approved' &&
      !(restoringPublication && config.status === 'superseded')) ||
    (copy.status !== 'approved' &&
      !(restoringPublication && copy.status === 'superseded'))
  ) {
    throw new StoreConflictError(
      'Publication requires approved config and copy versions belonging to this report',
    );
  }

  if (copy.source !== 'agent' && copy.basisRunId !== triple.runId) {
    throw new StoreConflictError(
      'Human copy must be explicitly reviewed for this run',
    );
  }

  // The run's assurance is the copy validation receipt bound to its stored
  // grounding and pinned verifier role; agent and human copy are held to it
  // alike.
  try {
    const pinned = readModelProfile(run.request);

    if (!pinned) {
      throw new Error('Pinned verifier profile is missing.');
    }

    assertCopyValidation({
      copy: copy.copy,
      provenance: copy.provenance,
      receipt: copy.validation,
      config: config.config,
      configVersion: triple.configVersion,
      snapshot: aeoSnapshotSchema.parse(artifact.snapshot),
      runId: triple.runId,
      grounding: artifact.grounding,
      verifierProfile:
        internalModelProfileSchema.parse(pinned).roles.premiseVerifier,
    });
  } catch (error) {
    throw new StoreConflictError(
      'Publication requires current copy validation bound to the stored grounding, source passages, assessments and model profile',
      { cause: error },
    );
  }

  const publishable = { run, artifact, config, copy };

  return publishable;
};

/** Whether a recorded copy validation is from the current checker. */
export const isCurrentValidation = (value: unknown): boolean => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'checkerVersion' in value &&
    value.checkerVersion === copyCheckerVersion &&
    'valid' in value &&
    value.valid === true
  );
};
