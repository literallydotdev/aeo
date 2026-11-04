import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readEnv, writeEnv } from '../lib/env';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// Settings for a local run (specs/aeo-open-source-cli-spec.md §4.2): the
// process environment first, then the env file for what it lacks. Only the
// file the operator names (or ./.env) is read: never .env.local, a parent
// directory or a production file. Every setting records where it came from,
// because an inherited shell variable silently wins over the file.
// ============================================================================

export type SettingSource = 'environment' | 'env_file';

export type Settings = {
  file: string;
  /** Whether the env file exists; an explicitly named file must. */
  fileFound: boolean;
  sourceOf: (name: string) => SettingSource | undefined;
  /** Copies what the file supplies into the process environment, for the
   * engine modules that still read it there; values already set win. */
  apply: (names: readonly string[]) => void;
  values: (names: readonly string[]) => string[];
};

/** readSettings reads the env file a command was given, or ./.env. */
export const readSettings = async (
  envFile: string | undefined,
): Promise<Settings> => {
  const file = path.resolve(envFile ?? '.env');
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (envFile === undefined && hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw new Error(`Please check --env-file: ${file} cannot be read.`, {
      cause: err,
    });
  });
  const fromFile = text === undefined ? {} : parseEnv(text);

  const valueOf = (name: string): string | undefined => {
    const environment = readEnv(name);

    return environment !== undefined && environment !== ''
      ? environment
      : fromFile[name];
  };

  const sourceOf = (name: string): SettingSource | undefined => {
    const environment = readEnv(name);

    if (environment !== undefined && environment !== '') {
      return 'environment';
    }

    return fromFile[name] ? 'env_file' : undefined;
  };

  const apply = (names: readonly string[]) => {
    for (const name of names) {
      if (sourceOf(name) === 'env_file') {
        writeEnv(name, fromFile[name]);
      }
    }
  };

  const values = (names: readonly string[]) => {
    return names.flatMap((name) => {
      const value = valueOf(name);

      return value ? [value] : [];
    });
  };

  const settings: Settings = {
    file,
    fileFound: text !== undefined,
    sourceOf,
    apply,
    values,
  };

  return settings;
};
