import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { criteriaForRole, producerGuidance } from '../harness/criteria';
import type { AeoAuditConfig } from '../schema';
import type { CapturedUnitRecord } from '../stores/ports';
import { isStageName, stageJsonSchema, stageSchemas } from './schemas';

// ============================================================================
// The work directory (specs/aeo-codex-workflow-spec.md §3): everything a
// Codex stage reads, written once by the host from the run's banked
// captures. Answers are one file each so a row can name the file it judges and
// the host can check a quote against the file's body. The appended sources
// block is kept, marked, so a stage sees what was cited without mistaking a
// publisher for a mention.
// ============================================================================

export const sourcesMarker = 'Sources used by search:';

export type AnswerFile = {
  /** Path relative to the work directory. */
  file: string;
  sectionKey: string;
  promptId: string;
  surface: string;
  runIndex: number;
  /** The answer without the appended sources block. */
  body: string;
};

const plainSegmentPattern = /^[a-z0-9_-]+$/;
const plainBytePattern = /[a-z0-9_-]/;

/**
 * answerPathSegment turns a free-form config string (a section key, a
 * prompt id) into one path segment that cannot traverse, nest or collide.
 * Every key in use today is lowercase snake case and stays as it is, so the
 * answer paths, and the batch digests built from them, are unchanged. Any
 * other value has each byte outside [a-z0-9_-] percent-encoded with
 * uppercase hex: an encoded segment always holds a '%' and a plain one never
 * does, so no two values share a segment, even on a case-insensitive
 * filesystem.
 */
export const answerPathSegment = (value: string): string => {
  if (value.length === 0) {
    throw new Error('Invalid empty path segment provided for an answer file.');
  }

  if (plainSegmentPattern.test(value)) {
    return value;
  }

  const encoded = [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);

      return plainBytePattern.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');

  return encoded;
};

/** The ANSWERS/ folder of one section, with its trailing slash. */
export const answerSectionPrefix = (sectionKey: string): string => {
  return `ANSWERS/${answerPathSegment(sectionKey)}/`;
};

export const answerFilePath = (record: {
  sectionKey: string;
  promptId: string;
  surface: string;
  runIndex: number;
}): string => {
  // Joined by hand: path.posix.join would normalize a '..' segment away.
  return `${answerSectionPrefix(record.sectionKey)}${answerPathSegment(record.promptId)}/${record.surface}-${record.runIndex}.md`;
};

/** The body of a captured answer: everything before the sources block. */
export const answerBody = (text: string): string => {
  const at = text.lastIndexOf(sourcesMarker);

  return (at < 0 ? text : text.slice(0, at)).trim();
};

export const materializeWorkdir = async (args: {
  dir: string;
  config: AeoAuditConfig;
  captured: readonly CapturedUnitRecord[];
  copyRules: string;
}): Promise<AnswerFile[]> => {
  const { dir, config } = args;

  for (const sub of ['ANSWERS', 'RULES', 'SCHEMA', 'OUT', 'JOURNAL']) {
    await mkdir(path.join(dir, sub), { recursive: true });
  }

  await writeFile(
    path.join(dir, 'CONFIG.json'),
    JSON.stringify(
      {
        brand: config.brand,
        competitors: config.competitors,
        sections: config.sections.map((section) => ({
          key: section.key,
          competitors: section.competitors ?? null,
          prompts: section.prompts.map((prompt) => ({
            id: prompt.id,
            text: prompt.text,
          })),
        })),
      },
      null,
      2,
    ),
  );

  const answers: AnswerFile[] = [];

  for (const record of args.captured) {
    const file = answerFilePath(record);
    const text = record.probe.text;
    const at = text.lastIndexOf(sourcesMarker);
    const body = answerBody(text);
    const sources = at < 0 ? '' : text.slice(at);
    const content = [
      `# Answer`,
      ``,
      `- section: ${record.sectionKey}`,
      `- prompt: ${record.promptId}`,
      `- surface: ${record.surface}`,
      `- run: ${record.runIndex}`,
      ``,
      `## Prompt`,
      ``,
      record.promptText,
      ``,
      `## Answer body`,
      ``,
      body,
      ``,
      ...(sources
        ? [
            `## Cited sources (appended by the capture; a publisher named only here is a citation, not a mention)`,
            ``,
            sources,
          ]
        : []),
      ``,
    ].join('\n');

    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
    answers.push({
      file,
      sectionKey: record.sectionKey,
      promptId: record.promptId,
      surface: record.surface,
      runIndex: record.runIndex,
      body,
    });
  }

  const criteria = (['evidence', 'final'] as const).flatMap((role) =>
    criteriaForRole(role),
  );
  const seen = new Set<string>();
  const criteriaText = criteria
    .filter((criterion) => !seen.has(criterion.id) && seen.add(criterion.id))
    .map(
      (criterion) =>
        `### ${criterion.id} (${criterion.severity})\n\n${criterion.description}\n\n${criterion.guidance}\n`,
    )
    .join('\n');

  await writeFile(
    path.join(dir, 'CRITERIA.md'),
    [
      `# Criteria`,
      ``,
      `The measured product is ${config.brand.name} (${config.brand.domain}${config.brand.aliases.length ? `; also known as ${config.brand.aliases.join(', ')}` : ''}). Every judgment below is about that product and nothing else.`,
      ``,
      `## Producer guidance: analysis`,
      ``,
      producerGuidance('analysis'),
      ``,
      `## Producer guidance: enrichment`,
      ``,
      producerGuidance('enrichment'),
      ``,
      `## Producer guidance: copy`,
      ``,
      producerGuidance('copy_block'),
      ``,
      `## Reviewer criteria`,
      ``,
      criteriaText,
    ].join('\n'),
  );
  await writeFile(
    path.join(dir, 'RULES', 'analysis.md'),
    [
      `# Analysis rules`,
      ``,
      producerGuidance('analysis'),
      ``,
      producerGuidance('enrichment'),
      ``,
      `A name that appears only inside a URL, a bare domain path or the cited-sources block is a citation, not a mention. Judge the answer body only.`,
      ``,
      `An answer that does not mention the measured product never lists the product, its domain or one of its aliases in mentionedBrands, not even as a runtime, a language or a parent brand: the two fields are one judgment, and the host drops such an entry. Mention the runtime in contextSnippet or the notes instead.`,
      ``,
      `## Positions`,
      ``,
      `- primary: the first or main recommendation of the answer.`,
      `- secondary: recommended, but after or beneath the main recommendation.`,
      `- listed: named in a list or a comparison without being recommended.`,
      `- absent: not named in the answer body.`,
      ``,
    ].join('\n'),
  );
  await writeFile(path.join(dir, 'RULES', 'copy.md'), args.copyRules);

  for (const stage of Object.keys(stageSchemas).filter(isStageName)) {
    await writeFile(
      path.join(dir, 'SCHEMA', `${stage}.json`),
      JSON.stringify(stageJsonSchema(stage), null, 2),
    );
  }

  await writeFile(
    path.join(dir, 'ANSWERS', 'INDEX.json'),
    JSON.stringify(
      answers.map(({ body: _body, ...entry }) => entry),
      null,
      2,
    ),
  );

  return answers;
};
