import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJournal } from '../bundle/journal';
import { openRecorder } from '../bundle/recorder';
import { recordedGroundingTools } from './recorded-tools';
import type { GroundingTools } from './tools';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-recorded-tools-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const context = () => ({
  sources: [],
  allowedUrls: [],
  signal: new AbortController().signal,
});

const finishedOperations = async () => {
  const text = await readFile(
    path.join(root, 'JOURNAL/run/events.jsonl'),
    'utf8',
  );

  return readJournal(text).events.filter(
    (event) => event.type === 'operation_finished',
  );
};

const recorderFor = () => {
  return openRecorder(root, {
    origin: 'local',
    runId: 'run-1',
    measurementDigest: 'm',
    planDigest: 'p',
  });
};

describe('recorded-tools - recordedGroundingTools()', () => {
  it('should record a refused search as a failed operation with its reason', async () => {
    const tools: GroundingTools = {
      searchProvider: 'dataforseo-google-organic-v1',
      execute: () =>
        Promise.resolve({
          kind: 'failure',
          reason: 'invalid_query',
          retryable: false,
        }),
    };
    const recorded = recordedGroundingTools(tools, await recorderFor());

    await recorded.execute(
      {
        tool: 'search_sources',
        candidateIds: ['c1'],
        question: 'What does Acme charge?',
        query: 'acme pricing',
      },
      context(),
    );
    const [finished] = await finishedOperations();

    expect(finished?.payload).toMatchObject({
      outcome: 'failed',
      details: { resultKind: 'failure', reason: 'invalid_query' },
    });
  });

  it('should record a thrown tool error as failed and pass the error on', async () => {
    const tools: GroundingTools = {
      searchProvider: 'disabled',
      execute: () => Promise.reject(new Error('connection reset')),
    };
    const recorded = recordedGroundingTools(tools, await recorderFor());

    const call = recorded.execute(
      {
        tool: 'fetch_source',
        candidateIds: ['c1'],
        relevance: 'pricing page',
        url: 'https://acme.example/',
      },
      context(),
    );

    await expect(call).rejects.toThrow('connection reset');
    expect((await finishedOperations())[0]?.payload).toMatchObject({
      outcome: 'failed',
      details: { error: 'connection reset' },
    });
  });
});
