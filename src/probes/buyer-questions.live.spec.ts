import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AiModule from 'ai';
import { literally2026Q3 } from '../configs/literally-2026-q3';
import { readEnv, requireEnv } from '../lib/env';
import { servedModelOf } from '../models/served-model';
import {
  bindingOf,
  createChatAdapter,
  defaultProbeBindings,
  probeDependenciesOf,
  type ModelBoundSurface,
  type ProbeDependencies,
} from './bindings';

// ============================================================================
// PAID, maintainer-run (.claude/rules/tests-cost-nothing.md): six buyer
// questions, once each, on each of the four API chat surfaces under its
// default binding. 24 probes, each one search call and, when that returns
// no prose, one follow-up. At the adapters' high estimates that is $2.94;
// the suite stops asking before the next probe could take what it has
// spent past AEO_LIVE_MAX_USD (3 by default), counting a probe that
// reported no cost at its high estimate.
//
// It measures what a canary on one factual question cannot (method release
// spec §4.4): whether a search call finishes inside its adapter's output
// allowance on the questions an audit asks, how many answers carry no
// source, and what an answer costs. The questions are the first six of the
// engine's own self-audit, the ones the first run on buyer questions asked.
//
// Each answer and a running summary are written to AEO_LIVE_OUTPUT_DIR,
// which must lie outside the repository: an answer holds real pages and
// names.
//
//   AI_GATEWAY_API_KEY=... AEO_LIVE_OUTPUT_DIR=/path/outside/the/repo \
//     capped npx vitest run --config vitest.live.config.ts \
//     src/probes/buyer-questions.live.spec.ts
// ============================================================================

type StreamOptions = Parameters<typeof AiModule.streamText>[0];
type StreamResult = ReturnType<typeof AiModule.streamText>;

const streams: StreamResult[] = [];

// The real streamText, with each result kept: the adapter's own request is
// what gets measured, never a copy of it written here.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof AiModule>('ai');

  return {
    ...actual,
    streamText: (options: StreamOptions) => {
      const result = actual.streamText(options);
      streams.push(result);

      return result;
    },
  };
});

const market = { geography: 'US', language: 'en' };
const defaultMaxUsd = 3;

// The dearest surface last: if the budget runs short, it is the one cut.
const surfaces = [
  'chatgpt',
  'gemini',
  'perplexity',
  'claude',
] as const satisfies readonly ModelBoundSurface[];

const questions = (literally2026Q3.sections[0]?.prompts ?? []).slice(0, 6);

const cases = surfaces.flatMap((surface) =>
  questions.map(({ id, text }) => ({ surface, promptId: id, question: text })),
);

type Measured = {
  surface: ModelBoundSurface;
  promptId: string;
  adapter: string;
  requestedModel: string;
  servedModel: string | null;
  /** 1: the search call wrote the answer. 2: the follow-up did. */
  calls: number;
  searchCall: {
    finishReason: string;
    outputTokens: number | null;
    reasoningTokens: number | null;
    inputTokens: number | null;
    toolCalls: number;
  } | null;
  retrievalCalls: number | null;
  sourceCount: number;
  linksInAnswer: number;
  answerChars: number;
  reportedCostUsd: number | null;
  seconds: number;
  failure?: string;
};

const linkPattern = /https?:\/\/[^\s)\]>"]+/g;

describe('buyer questions on the default bindings (live, paid)', () => {
  const measured: Measured[] = [];
  let dependencies: ProbeDependencies;
  let outputDir: string;
  let maxUsd: number;
  let spentUsd = 0;

  const writeSummary = () => {
    const bySurface = surfaces.map((surface) => {
      const rows = measured.filter((row) => row.surface === surface);
      const answered = rows.filter((row) => row.failure === undefined);
      const costs = answered.flatMap((row) => row.reportedCostUsd ?? []);

      return {
        surface,
        adapter: rows[0]?.adapter ?? null,
        model: rows[0]?.requestedModel ?? null,
        asked: rows.length,
        answered: answered.length,
        writtenByFollowUp: answered.filter((row) => row.calls > 1).length,
        searchCallsEndedOnLength: answered.filter(
          (row) => row.searchCall?.finishReason === 'length',
        ).length,
        withoutAnySource: answered.filter(
          (row) => row.sourceCount === 0 && row.linksInAnswer === 0,
        ).length,
        maxOutputTokens: Math.max(
          0,
          ...answered.map((row) => row.searchCall?.outputTokens ?? 0),
        ),
        costUsd: {
          reported: costs.length,
          min: costs.length > 0 ? Math.min(...costs) : null,
          max: costs.length > 0 ? Math.max(...costs) : null,
          total: costs.reduce((sum, cost) => sum + cost, 0),
        },
      };
    });

    writeFileSync(
      path.join(outputDir, 'summary.json'),
      `${JSON.stringify({ maxUsd, spentUsd, bySurface, measured }, null, 2)}\n`,
    );
  };

  beforeAll(() => {
    const apiKey = requireEnv('AI_GATEWAY_API_KEY');

    outputDir = path.resolve(
      requireEnv(
        'AEO_LIVE_OUTPUT_DIR',
        'Please set AEO_LIVE_OUTPUT_DIR to a directory outside the repository; the answers are written there.',
      ),
    );
    maxUsd = Number(readEnv('AEO_LIVE_MAX_USD') ?? defaultMaxUsd);

    const repository = path.resolve(import.meta.dirname, '..', '..');

    if (!path.relative(repository, outputDir).startsWith('..')) {
      throw new Error(
        `AEO_LIVE_OUTPUT_DIR is inside the repository (${outputDir}). A raw answer is not fit to commit; name a directory outside it.`,
      );
    }

    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
      throw new Error(
        'AEO_LIVE_MAX_USD is not a positive amount. Please set it to the most this suite may spend, in US dollars.',
      );
    }

    if (questions.length !== 6) {
      throw new Error(
        `Expected six questions from the self-audit config, found ${questions.length}.`,
      );
    }

    mkdirSync(outputDir, { recursive: true });
    dependencies = probeDependenciesOf(
      { AI_GATEWAY_API_KEY: apiKey },
      defaultProbeBindings,
    );
  });

  it.for(cases)(
    'should answer $promptId on $surface from a search',
    async ({ surface, promptId, question }, { skip }) => {
      const adapter = createChatAdapter(surface, { ...market, dependencies });
      const reserveUsd = adapter.estimateUsd.high;

      // Never past the approved amount: an unasked probe is reported as
      // skipped, not as a result.
      if (spentUsd + reserveUsd > maxUsd) {
        skip(
          `Not asked: $${spentUsd.toFixed(2)} spent, and this probe could cost $${reserveUsd.toFixed(2)} more than AEO_LIVE_MAX_USD allows.`,
        );
      }

      const requestedModel = bindingOf(defaultProbeBindings, surface).model;
      const firstStream = streams.length;
      const startedAt = Date.now();
      const row: Measured = {
        surface,
        promptId,
        adapter: adapter.id,
        requestedModel: requestedModel ?? '',
        servedModel: null,
        calls: 0,
        searchCall: null,
        retrievalCalls: null,
        sourceCount: 0,
        linksInAnswer: 0,
        answerChars: 0,
        reportedCostUsd: null,
        seconds: 0,
      };

      try {
        const answer = await adapter.probe(question, {});
        const first = streams[firstStream];

        if (first) {
          const [finishReason, usage, toolCalls] = await Promise.all([
            first.finishReason,
            first.totalUsage,
            first.toolCalls,
          ]);

          row.searchCall = {
            finishReason,
            outputTokens: usage.outputTokens ?? null,
            reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
            inputTokens: usage.inputTokens ?? null,
            toolCalls: toolCalls.length,
          };
        }

        row.servedModel =
          servedModelOf(row.requestedModel, answer.servedModel) ?? null;
        row.retrievalCalls = answer.retrieval?.calls.length ?? null;
        row.sourceCount =
          answer.sources.format === 'search'
            ? answer.sources.sources.length
            : 0;
        row.linksInAnswer = answer.answerText.match(linkPattern)?.length ?? 0;
        row.answerChars = answer.answerText.length;
        row.reportedCostUsd = answer.reportedCostUsd ?? null;

        writeFileSync(
          path.join(outputDir, `${surface}-${promptId}.json`),
          `${JSON.stringify({ ...row, question, answerText: answer.answerText, sources: answer.sources, retrieval: answer.retrieval }, null, 2)}\n`,
        );

        expect(answer.answerText.trim()).not.toBe('');
      } catch (error) {
        row.failure = error instanceof Error ? error.message : String(error);

        throw error;
      } finally {
        row.calls = streams.length - firstStream;
        row.seconds = (Date.now() - startedAt) / 1000;
        // A probe that reported no cost keeps what it could have cost.
        spentUsd += row.reportedCostUsd ?? reserveUsd;
        measured.push(row);
        writeSummary();
      }
    },
  );
});
