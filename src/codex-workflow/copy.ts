import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateAgentCopy,
  type CopyValidationResult,
} from '../agents/copy-validation';
import type { AeoReportCopy } from '../agents/copy-schema';
import { copywriterDocuments } from '../agents/copywriter-input';
import { buildFactCatalog } from '../agents/facts';
import {
  createRecommendationVerifier,
  type VerifierMemory,
} from '../agents/verifier';
import type { GroundingBundle } from '../grounding/schema';
import {
  aeoSnapshotSchema,
  type AeoAuditConfig,
  type AeoSnapshot,
} from '../schema';
import type { ModelCallAccounting } from '../models/accounting';
import type { InternalModelRoleConfig } from '../models/profiles';
import { engineResources } from '../engine/resources';
import { getEnvironment } from '../lib/env';
import { hostStepAccounting } from './host-models';

// ============================================================================
// The copy stage's host half (specs/aeo-codex-workflow-spec.md §4, §6):
// the writer's documents built from the finished snapshot by the existing
// copywriter input projection, and the draft held to the existing copy
// validation, premise verifier included, on the run's pinned role.
// ============================================================================

export const copyDir = 'COPY';

/**
 * Where the copywriter's and author's rule files are, and the editorial
 * context the copy describes its publisher with: AEO_AUTHOR_DIR and
 * AEO_EDITORIAL_DIR when set, otherwise the engine's own rules and its
 * neutral editorial context. A publisher's private editorial files are read
 * only when AEO_EDITORIAL_DIR names them (specs/aeo-open-source-cli-spec.md
 * §3, §14).
 */
export const authorDir = async (
  env: NodeJS.ProcessEnv = getEnvironment(),
): Promise<{ author: string; company: string }> => {
  const resources = await engineResources();

  return {
    author: env.AEO_AUTHOR_DIR ?? resources.author,
    company: env.AEO_EDITORIAL_DIR ?? resources.editorial,
  };
};

/** The copywriter's rule files, from wherever `authorDir` finds them. */
export const copywriterFiles = async (
  env: NodeJS.ProcessEnv = getEnvironment(),
): Promise<Record<string, string>> => {
  const { author, company } = await authorDir(env);
  const files: Record<string, string> = {
    'RULES.md': await readFile(path.join(author, 'COPY_RULES.md'), 'utf8'),
    'banlist.json': await readFile(path.join(author, 'banlist.json'), 'utf8'),
  };

  for (const file of ['COMPANY', 'positioning', 'services']) {
    files[`company/${file}.md`] = await readFile(
      path.join(company, `${file}.md`),
      'utf8',
    );
  }

  return files;
};

export const readSnapshot = async (dir: string): Promise<AeoSnapshot> => {
  const raw = await readFile(
    path.join(dir, 'OUT', 'snapshot.json'),
    'utf8',
  ).catch(() => null);

  if (raw === null) {
    throw new Error(
      'OUT/snapshot.json is missing: the finish step runs before the copy stage.',
    );
  }

  return aeoSnapshotSchema.parse(JSON.parse(raw));
};

/** Everything the write stage reads, under COPY/: the fact catalog
 * projection, the scope, the audit context, the criteria and the rules. */
export const materializeCopyInputs = async (args: {
  dir: string;
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  runId: string;
  grounding: GroundingBundle | null;
  /** A rewrite pass: the draft the reviewer saw and what they asked for. */
  previous?: AeoReportCopy | null;
  notes?: readonly string[];
}): Promise<string[]> => {
  const { dir } = args;
  const catalog = buildFactCatalog({
    snapshot: args.snapshot,
    config: args.config,
    runId: args.runId,
    grounding: args.grounding ?? undefined,
  });

  const documents: Record<string, string> = {
    ...(await copywriterFiles()),
    ...copywriterDocuments({
      config: args.config,
      snapshot: args.snapshot,
      catalog,
    }),
  };

  if (args.previous && args.notes?.length) {
    documents['PREVIOUS.json'] = JSON.stringify(args.previous, null, 2);
    documents['NOTES.md'] = [
      '# Reviewer notes',
      '',
      'The reviewer read PREVIOUS.json and asked for these changes, in order; a later note overrides an earlier one where they disagree.',
      '',
      ...args.notes.map(
        (note, index) => `${index + 1}. ${note.trim() || '(no text)'}`,
      ),
      '',
    ].join('\n');
  }

  const written: string[] = [];

  for (const [name, content] of Object.entries(documents)) {
    const file = path.join(dir, copyDir, name);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    written.push(path.posix.join(copyDir, name));
  }

  return written.sort();
};

/** The host's verdict on a draft: schema, facts, banlist, premises, and
 * the premise verifier on the run's pinned role. `invalid_copy` is the only
 * outcome that requires a verifier edit; operational failures retain the draft. */
export const validateCopyDraft = async (args: {
  draft: unknown;
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  runId: string;
  configVersion: number | undefined;
  grounding: GroundingBundle | null;
  secrets: readonly string[];
  /** The premise verifier role the run pinned: the publication gate
   * re-checks the receipt against exactly that role, so the draft must be
   * verified by it. */
  verifierRole: InternalModelRoleConfig;
  /** A rewrite pass keeps what the reviewer did not question: the logo
   * and eyebrow of the draft they saw. */
  previous?: AeoReportCopy | null;
  /** The report's logo, applied to the validated copy. */
  brandLogo?: AeoReportCopy['brandLogo'];
  /** The accounting the verifier's calls are charged to; a memory budget
   * when the caller has none. */
  accounting?: ModelCallAccounting;
  verifierMemory?: VerifierMemory;
  signal?: AbortSignal;
}): Promise<CopyValidationResult> => {
  const verifierProfile = args.verifierRole;
  const accounting = args.accounting ?? hostStepAccounting();

  return validateAgentCopy({
    draft: args.draft,
    config: args.config,
    snapshot: args.snapshot,
    runId: args.runId,
    configVersion: args.configVersion,
    grounding: args.grounding ?? undefined,
    verifierProfile,
    verifier: createRecommendationVerifier({
      accounting,
      profile: verifierProfile,
      memory: args.verifierMemory,
    }),
    previous: args.previous,
    brandLogo: args.brandLogo,
    secrets: args.secrets,
    signal: args.signal,
  });
};
