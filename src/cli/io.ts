// ============================================================================
// Arguments and output for literally-aeo (specs/aeo-open-source-cli-spec.md
// §4.3): results on stdout, progress and branding on stderr, so --json
// output stays machine-readable.
// ============================================================================

export type Flags = {
  positional: string[];
  options: Map<string, string>;
  switches: Set<string>;
};

const valueOptions = new Set([
  '--output',
  '--env-file',
  '--config',
  '--budget-file',
  '--port',
  '--brief',
  '--redact',
  '--max-usd',
  '--model',
]);

export const parseFlags = (argv: readonly string[]): Flags => {
  const flags: Flags = {
    positional: [],
    options: new Map(),
    switches: new Set(),
  };

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';

    if (valueOptions.has(arg)) {
      const value = argv[at + 1];

      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Please give ${arg} a value.`);
      }

      flags.options.set(arg, value);
      at += 1;
    } else if (arg.startsWith('--')) {
      flags.switches.add(arg);
    } else {
      flags.positional.push(arg);
    }
  }

  return flags;
};

export const writeOut = (text: string) => {
  process.stdout.write(`${text}\n`);
};

export const writeErr = (text: string) => {
  process.stderr.write(`${text}\n`);
};

/** A label column, for the human output of every command. */
export const formatLine = (label: string, value: string, width = 32) => {
  return `${`${label}:`.padEnd(width)}${value}`;
};
