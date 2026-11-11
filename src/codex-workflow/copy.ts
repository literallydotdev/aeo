import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateAgentCopy,
  type CopyValidationResult,
} from '../agents/copy-validation';
import {
  finalCopyDraftSchemaForSections,
  type AeoReportCopy,
} from '../agents/copy-schema';
import {
  copywriterDocuments,
  quotedAnswerHeading,
} from '../agents/copywriter-input';
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
import {
  generateStructured,
  structuredCallReservation,
  type StructuredCallUsage,
  type StructuredTransport,
} from '../models/structured';
import { engineResources } from '../engine/resources';
import { getEnvironment } from '../lib/env';
import { isRecord } from '../lib/type-guards';
import { hostStepAccounting } from './host-models';
import { stagePrompts } from './prompts';

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

/** The documents under COPY/ as one request carries them: each by the name
 * it has there, complete. `files` is what materializeCopyInputs wrote, so a
 * file an earlier pass left behind is never read. */
export const readCopyDocuments = async (
  dir: string,
  files: readonly string[],
): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    files.map(async (file) => {
      const name = path.posix.relative(copyDir, file);

      return [name, await readFile(path.join(dir, file), 'utf8')] as const;
    }),
  );

  return Object.fromEntries(entries);
};

type CopyDocuments = Readonly<Record<string, string>>;

/** What a request too large for its role gives up, in this order. The
 * measured facts, the assessments and the rules are never given up: a
 * request that cannot carry those is refused, and the report ships on its
 * facts. */
const copyDraftTrims: readonly {
  name: string;
  apply: (documents: CopyDocuments) => CopyDocuments;
}[] = [
  {
    name: 'quoted answer material',
    apply: (documents) => {
      const snapshot = documents['SNAPSHOT.md'];
      const cut = snapshot?.lastIndexOf(quotedAnswerHeading) ?? -1;

      return snapshot === undefined || cut < 0
        ? documents
        : { ...documents, 'SNAPSHOT.md': snapshot.slice(0, cut) };
    },
  },
  {
    name: 'company notes',
    apply: (documents) => {
      return Object.fromEntries(
        Object.entries(documents).filter(
          ([name]) => !name.startsWith('company/'),
        ),
      );
    },
  },
  {
    name: 'unverified claim observations',
    apply: (documents) => {
      const facts: unknown = JSON.parse(documents['FACTS.json'] ?? 'null');

      if (!isRecord(facts) || !Array.isArray(facts.facts)) {
        return documents;
      }

      return {
        ...documents,
        'FACTS.json': JSON.stringify({
          ...facts,
          facts: facts.facts.filter(
            (fact) => !isRecord(fact) || fact.kind !== 'observed_claim',
          ),
        }),
      };
    },
  },
];

/**
 * copyDraftCall is the one request that writes the report's narrative
 * (method release spec §4.5): the write stage's instructions, every
 * document under COPY/ and the draft's schema, on the run's copy role. No
 * tools and no files: what the writer may say is what the request holds.
 */
export const copyDraftCall = (args: {
  role: InternalModelRoleConfig;
  documents: CopyDocuments;
  /** The configured section keys: the schema names each as a required
   * key, so a draft cannot come back without one. */
  sections: readonly string[];
}) => {
  // The same contract as writeOutputSchema, with the sections named.
  const schema = finalCopyDraftSchemaForSections(args.sections);
  const call = (documents: CopyDocuments, omitted: readonly string[]) => {
    return {
      role: args.role,
      schema,
      system: stagePrompts.write,
      prompt: JSON.stringify({
        documents,
        ...(omitted.length > 0 && { omitted }),
      }),
    };
  };

  let { documents } = args;
  const omitted: string[] = [];

  for (const trim of [undefined, ...copyDraftTrims]) {
    if (trim) {
      documents = trim.apply(documents);
      omitted.push(trim.name);
    }

    const candidate = call(documents, omitted);

    try {
      structuredCallReservation(candidate);

      return { ...candidate, omitted };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'model_input_limit') {
        throw error;
      }
    }
  }

  throw new Error('model_input_limit');
};

/** draftCopy asks the copy role for the draft, once. The answer is held to
 * the draft's schema by the call; the host's verdict on it (facts, banlist,
 * premises, the premise verifier) is validateCopyDraft's. */
export const draftCopy = async (
  args: {
    role: InternalModelRoleConfig;
    documents: CopyDocuments;
    sections: readonly string[];
    accounting: ModelCallAccounting;
    signal?: AbortSignal;
  },
  transport?: StructuredTransport,
): Promise<{
  /** Held to the draft's schema by the call. */
  draft: unknown;
  usage: StructuredCallUsage;
  omitted: readonly string[];
}> => {
  const { omitted, ...call } = copyDraftCall(args);
  const result = await generateStructured(
    {
      roleName: 'copy',
      accounting: args.accounting,
      signal: args.signal,
      ...call,
    },
    transport,
  );

  return { draft: result.output, usage: result.usage, omitted };
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
