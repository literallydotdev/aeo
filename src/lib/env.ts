// The one place that reads environment variables. Everything else calls these
// helpers, so a missing value fails with one clear message. `NEXT_PUBLIC_*`
// values stay literal `process.env.NEXT_PUBLIC_*` reads, because Next.js
// inlines them into the client bundle by that exact expression.

/**
 * readEnv returns an environment variable as set, or undefined when it is
 * not set. An empty string stays an empty string.
 */
export const readEnv = (name: string): string | undefined => {
  return process.env[name];
};

/**
 * getEnvironment returns the whole environment, for code that hands it to a
 * child process or copies selected keys from it.
 */
export const getEnvironment = (): NodeJS.ProcessEnv => {
  return process.env;
};

/**
 * writeEnv sets an environment variable for this process and its children,
 * or removes it when `value` is undefined.
 */
export const writeEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];

    return;
  }

  process.env[name] = value;
};

/**
 * requireEnv returns a non-empty environment variable, or throws when it is
 * missing or empty. `message` replaces the default error text.
 */
export const requireEnv = (name: string, message?: string): string => {
  const value = readEnv(name);

  if (!value) {
    throw new Error(message ?? `Please set the ${name} environment variable.`);
  }

  return value;
};

export type RequiredEnvVar = {
  name: string;
  purpose: string;
};

/**
 * assertEnvVars is the fail-fast gate for the runner: it checks every
 * required variable and throws ONE error listing everything that is missing,
 * before any probe is sent or money is spent. Callers decide which variables
 * a given run needs.
 */
export const assertEnvVars = (required: readonly RequiredEnvVar[]): void => {
  const missing = required.filter((variable) => !readEnv(variable.name));

  if (missing.length === 0) {
    return;
  }

  const lines = missing.map(
    (variable) => `  - ${variable.name} — ${variable.purpose}`,
  );

  throw new Error(
    [
      `Missing required env var${missing.length === 1 ? '' : 's'}:`,
      ...lines,
      'Set them in .env.local (see the AEO runner section of .env.example),',
      'or narrow the run with --surfaces to skip the surfaces that need them.',
    ].join('\n'),
  );
};
