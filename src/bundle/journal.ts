import { access, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { mintRunId } from '../lib/run-id';
import { hasErrorCode } from '../stores/fs-errors';
import {
  bundleEventSchema,
  objectPathPrefix,
  type BundleEvent,
  type EventType,
} from './contracts';
import { canonicalDigest, parseBundleJson, sha256Hex } from './json';

// ============================================================================
// The run journal (specs/aeo-open-source-cli-spec.md §7.3): one host-owned
// JSONL sequence per run, hash-chained, written as work happens. Objects an
// event references are durable before the event; an event is durable before
// the work that depends on it. Hash chaining detects an edit relative to a
// retained head; the owner can still regenerate the whole chain, which is
// why a bundle's authenticity stays self-reported.
// ============================================================================

/** The digest an event carries: its canonical form without the digest. */
export const digestEvent = (event: Omit<BundleEvent, 'digest'>): string => {
  return canonicalDigest(event);
};

export type JournalEntry = {
  type: EventType;
  operationId?: string;
  payload?: Record<string, unknown>;
  objects?: readonly string[];
};

/** buildEvent chains one entry onto the journal head. */
export const buildEvent = (
  entry: JournalEntry,
  head: { count: number; digest: string | null },
  at: string,
): BundleEvent => {
  const unsigned = {
    seq: head.count,
    id: mintRunId(),
    type: entry.type,
    at,
    operationId: entry.operationId ?? null,
    payload: entry.payload ?? {},
    objects: [...(entry.objects ?? [])],
    previousDigest: head.digest,
  };
  const event = { ...unsigned, digest: digestEvent(unsigned) };

  return event;
};

export type JournalReading = {
  events: BundleEvent[];
  errors: string[];
  /** A final line without its newline: an append the process lost. */
  tornTail: string | undefined;
};

/** readJournal parses and chain-checks events.jsonl text. */
export const readJournal = (text: string): JournalReading => {
  const events: BundleEvent[] = [];
  const errors: string[] = [];
  const lines = text.split('\n');
  const last = lines.pop();
  const tornTail = last === undefined || last === '' ? undefined : last;
  let previous: string | null = null;

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;

    try {
      parsed = parseBundleJson(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      errors.push(`Line ${index + 1} is not valid JSON: ${message}`);
      break;
    }

    const result = bundleEventSchema.safeParse(parsed);

    if (!result.success) {
      errors.push(`Line ${index + 1} is not a valid event.`);
      break;
    }

    const { digest, ...unsigned } = result.data;

    if (result.data.seq !== index) {
      errors.push(`Line ${index + 1} has sequence ${result.data.seq}.`);
    }

    if (result.data.previousDigest !== previous) {
      errors.push(`Line ${index + 1} does not chain to the line before it.`);
    }

    if (digestEvent(unsigned) !== digest) {
      errors.push(`Line ${index + 1} does not match its own digest.`);
    }

    events.push(result.data);
    previous = digest;
  }

  return { events, errors, tornTail };
};

const syncDirectory = async (dir: string): Promise<void> => {
  const handle = await open(dir, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeDurably = async (file: string, bytes: string | Buffer) => {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w');

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
};

/** putObject stores immutable bytes under objects/sha256/ and returns the
 * digest an event references; durable before it returns. */
// Writes in flight, by object file. Two operations that store the same
// bytes at once (two technical checks with the same parameters, two empty
// answers) share one write: separate writes would race on one temporary
// name and the second rename would find it gone. One process writes a run
// directory (the writer lock), so this covers every writer of it.
const objectWrites = new Map<string, Promise<void>>();

const writeObject = async (file: string, bytes: string | Buffer) => {
  await mkdir(path.dirname(file), { recursive: true });

  // Content-addressed: an existing file already holds exactly these bytes.
  const exists = await access(file).then(
    () => true,
    () => false,
  );

  if (!exists) {
    await writeDurably(file, bytes);
  }
};

export const putObject = async (
  root: string,
  bytes: string | Buffer,
): Promise<string> => {
  const digest = sha256Hex(bytes);
  const file = path.join(root, objectPathPrefix, digest);
  let write = objectWrites.get(file);

  if (!write) {
    write = writeObject(file, bytes).finally(() => objectWrites.delete(file));
    objectWrites.set(file, write);
  }

  await write;

  return digest;
};

/**
 * openJournal opens a run directory's events.jsonl for appending. A torn
 * final line is quarantined beside the journal and recorded as an
 * interruption; any other defect refuses the journal, since resuming over a
 * broken chain would deliver a trace that looks complete and is not.
 */
export const openJournal = async (
  root: string,
  { now = () => new Date() } = {},
) => {
  const file = path.join(root, 'events.jsonl');

  await mkdir(root, { recursive: true });

  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return '';
    }

    throw err;
  });

  const reading = readJournal(text);

  if (reading.errors.length > 0) {
    throw new Error(
      `The run journal ${file} is damaged: ${reading.errors.join(' ')}`,
    );
  }

  const head = {
    count: reading.events.length,
    digest: reading.events.at(-1)?.digest ?? null,
  };
  let queue = Promise.resolve();

  const appendNow = async (entry: JournalEntry): Promise<BundleEvent> => {
    const event = buildEvent(entry, head, now().toISOString());
    const handle = await open(file, 'a');

    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    head.count = event.seq + 1;
    head.digest = event.digest;

    return event;
  };

  /** Appends are serialized: concurrent stages never interleave lines. */
  const append = (entry: JournalEntry): Promise<BundleEvent> => {
    const appended = queue.then(() => appendNow(entry));

    queue = appended.then(
      () => undefined,
      () => undefined,
    );

    return appended;
  };

  if (reading.tornTail !== undefined) {
    const quarantine = path.join(
      root,
      `events.torn.${now().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );
    const intact = text.slice(0, text.length - reading.tornTail.length);

    await writeDurably(quarantine, reading.tornTail);
    await writeDurably(file, intact);
    await append({
      type: 'run_interrupted',
      payload: {
        reason: 'torn_append',
        quarantined: path.basename(quarantine),
      },
    });
  } else {
    await syncDirectory(root);
  }

  const journal = {
    append,
    head: () => ({ ...head }),
  };

  return journal;
};

export type Journal = Awaited<ReturnType<typeof openJournal>>;
