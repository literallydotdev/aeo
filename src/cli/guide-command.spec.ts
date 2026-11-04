import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOperatorGuide } from './guide-command';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The CLI's usage text, read from its source: the entry module runs the
 * command when imported, so a test reads it instead. */
const readUsageText = async (): Promise<string> => {
  const source = await readFile(path.join(here, 'literally-aeo.ts'), 'utf8');
  const usage = /const usageText = `([\s\S]*?)`;/.exec(source)?.[1];

  if (usage === undefined) {
    throw new Error('The usage text was not found in literally-aeo.ts.');
  }

  return usage;
};

/** Every `literally-aeo <command> --flag` the guide tells an agent to run,
 * from its code spans and code blocks only. */
const guideInvocations = (guide: string) => {
  const code = [
    ...guide.matchAll(/```[a-z]*\n([\s\S]*?)```/g),
    ...guide.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g),
  ].map((match) => (match[1] ?? '').replace(/\s+/g, ' '));
  const invocations = code.flatMap((span) => {
    return [...span.matchAll(/literally-aeo ([a-z]+)([^&|;]*)/g)].map(
      (match) => ({
        command: match[1] ?? '',
        flags: [...(match[2] ?? '').matchAll(/--[a-z][a-z-]*/g)].map(
          (flag) => flag[0],
        ),
      }),
    );
  });

  return invocations;
};

describe('guide-command - readOperatorGuide()', () => {
  it('should print the guide the engine ships', async () => {
    const shipped = await readFile(
      path.join(here, '..', 'engine', 'guide', 'OPERATOR.md'),
      'utf8',
    );

    const guide = await readOperatorGuide();

    expect(guide).toBe(shipped);
  });

  it('should name only commands and flags the CLI has', async () => {
    const usage = await readUsageText();
    const invocations = guideInvocations(await readOperatorGuide());
    const commands = new Set(
      [...usage.matchAll(/^ {2}literally-aeo ([a-z]+)/gm)].map(
        (match) => match[1],
      ),
    );
    const flags = new Set(
      [...usage.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]),
    );

    const unknownCommands = invocations
      .map((invocation) => invocation.command)
      .filter((command) => !commands.has(command));
    const unknownFlags = invocations
      .flatMap((invocation) => invocation.flags)
      .filter((flag) => !flags.has(flag));

    expect(invocations.length).toBeGreaterThan(10);
    expect(unknownCommands).toEqual([]);
    expect([...new Set(unknownFlags)]).toEqual([]);
  });

  it('should hold every checkpoint of the protocol, in order', async () => {
    const guide = await readOperatorGuide();

    const checkpoints = [...guide.matchAll(/^## Checkpoint (\d+):/gm)].map(
      (match) => Number(match[1]),
    );

    expect(checkpoints).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
