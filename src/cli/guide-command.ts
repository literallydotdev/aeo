import { readFile } from 'node:fs/promises';
import { engineResources } from '../engine/resources';
import { writeOut, type Flags } from './io';

// ============================================================================
// literally-aeo guide (specs/aeo-claude-operator-spec.md §4.5): the operator
// guide for an AI agent running an audit for a user, printed from the
// installed package so it always matches the commands of this version.
// ============================================================================

/** readOperatorGuide returns the guide this engine ships. */
export const readOperatorGuide = async (): Promise<string> => {
  const { guide } = await engineResources();

  return readFile(guide, 'utf8');
};

export const runGuide = async (flags: Flags) => {
  const guide = await readOperatorGuide();

  writeOut(
    flags.switches.has('--json')
      ? JSON.stringify({ resultVersion: 1, command: 'guide', guide })
      : guide.trimEnd(),
  );

  return 0;
};
