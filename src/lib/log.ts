// ============================================================================
// Logging for the AEO toolchain: `createLog(component)` is the logger every
// module uses. It prints to the console, pretty and colored, info and up;
// AEO_DEBUG=1 shows debug too. The Codex stages keep their own durable record
// in the work directory (JOURNAL/ and the raw event stream next to it); the
// per-run log files under aeo/logs/ that the legacy runner wrote are gone.
// ============================================================================

import { readEnv } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

type LogEntry = {
  level: LogLevel;
  component: string;
  message: string;
  fields?: LogFields;
};

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ---------------------------------------------------------------------------
// Console formatting
// ---------------------------------------------------------------------------

// Read when a line is emitted, never into a constant at import: every
// module imports this one, and importing a library module reads nothing.
const useColor = (): boolean => {
  return Boolean(process.stdout.isTTY) && !readEnv('NO_COLOR');
};

const ansi = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
};

const paint = (text: string, color: string): string => {
  return useColor() ? `${color}${text}${ansi.reset}` : text;
};

const levelTags: Record<LogLevel, { text: string; color: string }> = {
  debug: { text: 'DEBUG', color: ansi.gray },
  info: { text: 'INFO ', color: ansi.cyan },
  warn: { text: 'WARN ', color: ansi.yellow },
  error: { text: 'ERROR', color: ansi.red },
};

const formatClockTime = (date: Date): string => {
  return date.toTimeString().slice(0, 8);
};

const formatFieldValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
};

/**
 * formatFields renders `key=value` pairs; non-primitive values render as
 * compact JSON.
 */
const formatFields = (fields?: LogFields): string => {
  if (!fields || Object.keys(fields).length === 0) {
    return '';
  }

  const parts = Object.entries(fields).map(([key, value]) => {
    return `${key}=${formatFieldValue(value)}`;
  });

  return ` ${parts.join(' ')}`;
};

const consoleMinLevel = (): LogLevel => {
  return readEnv('AEO_DEBUG') ? 'debug' : 'info';
};

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const emit = ({ level, component, message, fields }: LogEntry): void => {
  if (levelOrder[level] < levelOrder[consoleMinLevel()]) {
    return;
  }

  const tag = levelTags[level];
  const line = `${paint(formatClockTime(new Date()), ansi.dim)} ${paint(tag.text, tag.color)} ${paint(
    `[${component}]`,
    ansi.dim,
  )} ${message}${paint(formatFields(fields), ansi.dim)}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

const describeErrorDetail = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.message;
  }

  // Any other thrown value prints as String() does; JSON could throw on a
  // cyclic value inside the very catch block that is logging it.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Matches the logger's historical output for non-Error values.
  return error ? String(error) : undefined;
};

const maxCauseDepth = 10;

/**
 * describeCauseChain joins the messages of an error's `cause` chain, nearest
 * first, so a log line keeps what `console.error(error)` would have shown.
 * The depth limit guards against a cause that points back at itself.
 */
const describeCauseChain = (error: unknown): string | undefined => {
  const messages: string[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? error.cause : undefined;

  while (
    cause !== undefined &&
    !seen.has(cause) &&
    messages.length < maxCauseDepth
  ) {
    seen.add(cause);

    const message = describeErrorDetail(cause);

    if (message) {
      messages.push(message);
    }

    cause = cause instanceof Error ? cause.cause : undefined;
  }

  return messages.length > 0 ? messages.join(' <- ') : undefined;
};

export const createLog = (component: string) => {
  return {
    /** debug logs verbose detail, shown on the console only with AEO_DEBUG=1. */
    debug(message: string, fields?: LogFields) {
      emit({ level: 'debug', component, message, fields });
    },
    info(message: string, fields?: LogFields) {
      emit({ level: 'info', component, message, fields });
    },
    warn(message: string, fields?: LogFields) {
      emit({ level: 'warn', component, message, fields });
    },
    error(message: string, error?: unknown, fields?: LogFields) {
      const detail = describeErrorDetail(error);
      const cause = describeCauseChain(error);

      emit({
        level: 'error',
        component,
        message,
        fields: {
          ...(detail ? { error: detail } : {}),
          ...(cause ? { cause } : {}),
          ...(error instanceof Error && error.stack
            ? { stack: error.stack }
            : {}),
          ...fields,
        },
      });
    },
  };
};

export type Log = ReturnType<typeof createLog>;
