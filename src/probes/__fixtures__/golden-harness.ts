import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { readJournal } from '../../bundle/journal';
import { openRecorder, type ExecutionRecorder } from '../../bundle/recorder';
import { readEnv } from '../../lib/env';
import { isRecord } from '../../lib/type-guards';
import type { AgentRuntime } from '../agent-clis';
import type {
  ProbeAttemptEnd,
  ProbeAttemptStart,
  ProbeTrace,
} from '../probe-trace';

// ============================================================================
// Shared arrangements for the golden pins (probe adapters spec §7, phase 1):
// fake chat streams, a fake network for DataForSEO and Google's redirect
// wrappers, the fake agent CLI on PATH, and a real run journal read back
// with its operation ids numbered. Nothing here reaches a real provider.
// The pinned values live in golden/*.json; they record 0.2.2's behaviour
// and are never regenerated to make a test pass.
// ============================================================================

const fixturesDir = import.meta.dirname;

/** readGolden reads one of the pinned value files under golden/. */
export const readGolden = async (name: string): Promise<unknown> => {
  return JSON.parse(
    await readFile(path.join(fixturesDir, 'golden', name), 'utf8'),
  );
};

/**
 * expectGolden compares a pinned value with its recorded one, key order
 * included: a banked record and a journal object are stored as JSON, whose
 * bytes follow the order the keys were written in.
 */
export const expectGolden = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
};

/** fakeGateway stands in for the run's gateway provider: the model it
 * returns is the string `gateway:<model id>`, which the mocked `streamText`
 * receives and the pins record. */
export const fakeGateway = (modelId: string): string => {
  return `gateway:${modelId}`;
};

/** A settled stream: every member resolves from one answer. */
export const answeredStream = (fields: Record<string, unknown>): unknown => {
  return new Proxy(
    {},
    {
      get: (_target, key) =>
        Promise.resolve(typeof key === 'string' ? fields[key] : undefined),
    },
  );
};

/** A stream whose provider failed: `onError` saw the failure, and every
 * member rejects with the SDK's stand-in error. */
export const failedStream = (
  onError: ((event: { error: unknown }) => void) | undefined,
  error: unknown,
  standIn: Error,
): unknown => {
  onError?.({ error });

  return new Proxy({}, { get: () => Promise.reject(standIn) });
};

export type ChatFixture = {
  text: string;
  steps: unknown[];
  providerMetadata: unknown;
  sources: unknown[];
};

/** readChatFixture reads one captured AI SDK result (chat/README). */
export const readChatFixture = async (
  name: 'openai' | 'anthropic' | 'gemini',
): Promise<ChatFixture> => {
  return JSON.parse(
    await readFile(path.join(fixturesDir, 'chat', `${name}.json`), 'utf8'),
  ) as ChatFixture;
};

export type FakeNetwork = {
  fetch: typeof fetch;
  /** Every request in order: the URL, and the body DataForSEO received. */
  requests: Array<{ url: string; body: unknown }>;
};

/**
 * createFakeNetwork answers DataForSEO's SERP endpoint with `serp`, each
 * redirect wrapper in `redirects` with a 302 to its target, and anything
 * else with a 404, as a wrapper that no longer resolves does.
 */
export const createFakeNetwork = ({
  serp,
  redirects = {},
}: {
  serp?: unknown;
  redirects?: Record<string, string>;
}): FakeNetwork => {
  const requests: FakeNetwork['requests'] = [];

  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;

    requests.push({ url, body });

    if (url.startsWith('https://api.dataforseo.com/v3/')) {
      return Promise.resolve(Response.json(serp));
    }

    const target = redirects[url];

    return Promise.resolve(
      target === undefined
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 302, headers: { location: target } }),
    );
  };

  return { fetch: fakeFetch, requests };
};

/**
 * settle drives fake timers until `work` settles, yielding to the real
 * event loop between steps so file writes (the run journal) complete.
 */
export const settle = async <T>(work: Promise<T>): Promise<T> => {
  // An object, so the loop rereads what the callback below sets.
  const progress = { done: false };

  const finished = work.finally(() => {
    progress.done = true;
  });

  while (!progress.done) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  return finished;
};

const fakeCliPath = path.join(fixturesDir, 'fake-cli', 'fake-cli.mjs');

export type FakeCliHost = {
  root: string;
  binDir: string;
  /** A runtime whose CLIs answer in `mode`, or per CLI in `modes`. */
  runtime: (options: {
    mode?: string;
    modes?: Partial<Record<'claude' | 'codex' | 'cursor-agent', string>>;
    env?: Record<string, string>;
  }) => Promise<AgentRuntime>;
};

/**
 * createFakeCliHost puts the fake CLI on a PATH under one temporary root as
 * `claude`, `codex` and `cursor-agent`. The child gets only the allowlisted
 * environment, so each runtime's mode travels in files under its own HOME.
 * Codex is resolved through the runtime's AEO_CODEX_BIN, `<binDir>/codex`.
 */
export const createFakeCliHost = async (): Promise<FakeCliHost> => {
  const root = await mkdtemp(path.join(tmpdir(), 'aeo-golden-cli-'));
  const binDir = path.join(root, 'bin');
  let homes = 0;

  await mkdir(binDir);

  for (const name of ['claude', 'codex', 'cursor-agent']) {
    await symlink(fakeCliPath, path.join(binDir, name));
  }

  const runtime: FakeCliHost['runtime'] = async ({
    mode,
    modes = {},
    env = {},
  }) => {
    homes += 1;
    const home = path.join(root, `home-${homes}`);

    await mkdir(home);

    if (mode !== undefined) {
      await writeFile(path.join(home, '.fake-cli-mode'), mode, 'utf8');
    }

    for (const [cli, cliMode] of Object.entries(modes)) {
      await writeFile(path.join(home, `.fake-cli-mode.${cli}`), cliMode);
    }

    const agentRuntime: AgentRuntime = {
      env: {
        PATH: `${binDir}:${readEnv('PATH') ?? ''}`,
        HOME: home,
        // Codex is the package's own dependency unless the runtime names
        // another binary.
        AEO_CODEX_BIN: path.join(binDir, 'codex'),
        ...env,
      },
      claudeConfigDir: null,
      timeoutMs: 10_000,
    };

    return agentRuntime;
  };

  return { root, binDir, runtime };
};

/**
 * stubAgentEnvironment fixes the one process setting a CLI launch still
 * reads, the isolated container's guard in runChild, so a maintainer's own
 * environment never changes what the pins see. The adapters read their
 * settings from the runtime.
 */
export const stubAgentEnvironment = (): void => {
  vi.stubEnv('AEO_ISOLATED_ADAPTER', '');
};

const placeholderDigest = '0'.repeat(64);

/** openGoldenRecorder opens a real run journal in `dir`. */
export const openGoldenRecorder = async (
  dir: string,
): Promise<ExecutionRecorder> => {
  return openRecorder(dir, {
    origin: 'local',
    runId: 'golden',
    measurementDigest: placeholderDigest,
    planDigest: placeholderDigest,
  });
};

const relabel = (value: unknown, labels: Map<string, string>): unknown => {
  if (typeof value === 'string') {
    return labels.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => relabel(item, labels));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relabel(item, labels)]),
    );
  }

  return value;
};

export type JournaledOperation = {
  type: string;
  operation: string;
  payload: unknown;
  objects: string[];
};

/**
 * readOperations reads the operation events of `dir`'s run journal, with
 * each operation id replaced by `op-<n>` in the order operations started,
 * wherever it appears (a retry names the attempt it retries).
 */
export const readOperations = async (
  dir: string,
): Promise<JournaledOperation[]> => {
  const text = await readFile(
    path.join(dir, 'JOURNAL', 'run', 'events.jsonl'),
    'utf8',
  );
  const events = readJournal(text).events.filter(
    (event) =>
      event.type === 'operation_started' ||
      event.type === 'operation_finished',
  );
  const labels = new Map<string, string>();

  for (const event of events) {
    if (event.operationId !== null && !labels.has(event.operationId)) {
      labels.set(event.operationId, `op-${labels.size + 1}`);
    }
  }

  return events.map((event) => ({
    type: event.type,
    operation: labels.get(event.operationId ?? '') ?? 'none',
    payload: relabel(event.payload, labels),
    objects: event.objects,
  }));
};

export type PortCall =
  | { call: 'start'; attempt: ProbeAttemptStart }
  | { call: 'end'; result: ProbeAttemptEnd };

/**
 * spyTrace records what the probe layer hands the journal port, start and
 * end in order, and passes each call on to `inner`. Handle ids are
 * replaced by `op-<n>` so a retry's `retryOf` reads the same every run.
 */
export const spyTrace = (
  inner: ProbeTrace,
): { trace: ProbeTrace; calls: () => PortCall[] } => {
  const recorded: PortCall[] = [];
  const labels = new Map<string, string>();

  const trace: ProbeTrace = {
    start: async (attempt) => {
      recorded.push({ call: 'start', attempt });
      const handle = await inner.start(attempt);

      labels.set(handle.id, `op-${labels.size + 1}`);

      return {
        id: handle.id,
        end: async (result) => {
          recorded.push({ call: 'end', result });
          await handle.end(result);
        },
      };
    },
  };

  const calls = () => {
    return recorded.map((call) => relabel(call, labels) as PortCall);
  };

  return { trace, calls };
};
