import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  vi,
} from 'vitest';
import { probeTraceOf } from '../bundle/recorder';
import type { AeoAgentSurface } from '../schema';
import {
  createFakeCliHost,
  openGoldenRecorder,
  expectGolden,
  readGolden,
  readOperations,
  spyTrace,
  stubAgentEnvironment,
  type FakeCliHost,
} from './__fixtures__/golden-harness';
import {
  runAgentProbesForPrompts,
  runCanaryProbe,
  runCanaryProbes,
  type AgentProbeResult,
  type AgentRuntime,
} from './agent-clis';
import { unlimited } from './limits';

// ============================================================================
// Golden pins of every coding-agent probe path (probe adapters spec §7,
// phase 1). The fake CLI replays the captured streams in __fixtures__/ as
// each real CLI printed them, so the parsers read real output through the
// real child-process path. Each case pins the outcome, the banked probe,
// what the probe layer hands the journal port and the run journal a real
// recorder writes. The expected values in __fixtures__/golden/agent-probes.json
// record 0.2.2; a failing pin is a behaviour change to find, never a file
// to regenerate.
// ============================================================================

const prompt = {
  id: 'p1',
  promptText: 'Which managed file store should a small team adopt?',
  category: 'product_recommendation',
};

const versions = {
  claudeCode: 'fake-claude 1.0.0',
  codex: 'fake-codex 1.0.0',
  cursor: 'fake-cursor 1.0.0',
};

// The scratch directory a probe runs in has a random name; the arguments a
// CLI is started with are pinned with it replaced.
const scratchPattern = /[^"\s]*aeo-agent-probe-[A-Za-z0-9]+/g;

let root: string;
let host: FakeCliHost;
let golden: Record<string, unknown>;

beforeAll(async () => {
  host = await createFakeCliHost();
  golden = (await readGolden('agent-probes.json')) as Record<string, unknown>;
  stubAgentEnvironment(host);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(host.root, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-golden-agent-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** runCase runs one planned unit of `surface` through a real journal. */
const runCase = async (
  surface: AeoAgentSurface,
  {
    runtime,
    onResult,
  }: {
    runtime: AgentRuntime;
    onResult?: (result: AgentProbeResult) => Promise<void>;
  },
) => {
  const recorder = await openGoldenRecorder(root);
  const spy = spyTrace(probeTraceOf(recorder, 'probe'));
  const banked: AgentProbeResult[] = [];

  const batch = await runAgentProbesForPrompts({
    prompts: [prompt],
    surfaces: [surface],
    versions,
    runsPerPrompt: 1,
    runtime,
    limiter: unlimited(),
    trace: spy.trace,
    onResult:
      onResult ??
      ((result) => {
        banked.push(result);

        return Promise.resolve();
      }),
  });

  const pinned = {
    batch,
    banked,
    port: spy.calls(),
    journal: await readOperations(root),
  };

  return pinned;
};

/** argvOf runs one probe whose CLI answers with the arguments it got. */
const argvOf = async (
  surface: AeoAgentSurface,
  env: Record<string, string> = {},
) => {
  const { outcomes } = await runAgentProbesForPrompts({
    prompts: [prompt],
    surfaces: [surface],
    versions,
    runsPerPrompt: 1,
    runtime: await host.runtime({ mode: 'echo-args', env }),
    limiter: unlimited(),
  });
  const [outcome] = outcomes;

  if (outcome?.status !== 'captured') {
    throw new Error(`The ${surface} probe was not captured.`);
  }

  return JSON.parse(
    outcome.probe.text.replace(scratchPattern, '<scratch>'),
  ) as unknown;
};

describe('agent-clis - runAgentProbesForPrompts() golden pins', () => {
  it('should bank Claude Code from a captured stream that searched and fetched', async () => {
    const pinned = await runCase('claude_code', {
      runtime: await host.runtime({
        mode: 'replay claude-code-searched.ndjson',
      }),
    });

    expectGolden(pinned, golden.claudeCodeSearched);
  });

  it('should bank Claude Code from a captured stream without tool calls', async () => {
    const pinned = await runCase('claude_code', {
      runtime: await host.runtime({
        mode: 'replay claude-code-no-tools.ndjson',
      }),
    });

    expectGolden(pinned, golden.claudeCodeNoTools);
  });

  it('should bank Claude Code with an unknown usedWebSearch when the stream has no turn events', async () => {
    const pinned = await runCase('claude_code', {
      runtime: await host.runtime({ mode: 'result-only' }),
    });

    expectGolden(pinned, golden.claudeCodeUnknownWebSearch);
  });

  it('should bank Codex with the pinned model it asked for, learned from the answer', async () => {
    const pinned = await runCase('codex', {
      runtime: await host.runtime({
        mode: 'replay codex-searched.ndjson',
        env: { AEO_CODEX_PROBE_MODEL: 'gpt-5.6-sol' },
      }),
    });

    expectGolden(pinned, golden.codexPinnedModel);
  });

  it('should bank Codex without a requested model when none is pinned', async () => {
    const pinned = await runCase('codex', {
      runtime: await host.runtime({ mode: 'replay codex-no-tools.ndjson' }),
    });

    expectGolden(pinned, golden.codexDefaultModel);
  });

  it('should bank Cursor from a captured stream that searched and fetched', async () => {
    const pinned = await runCase('cursor', {
      runtime: await host.runtime({ mode: 'replay cursor-searched.ndjson' }),
    });

    expectGolden(pinned, golden.cursorSearched);
  });

  it('should record a retried failure with its message and both attempts', async () => {
    const pinned = await runCase('claude_code', {
      runtime: await host.runtime({ mode: 'exit1' }),
    });

    expectGolden(pinned, golden.retriedFailure);
  }, 30_000);

  it('should record a capture whose banking failed, and fail the unit as persistence', async () => {
    const pinned = await runCase('claude_code', {
      runtime: await host.runtime({ mode: 'ok' }),
      onResult: () => Promise.reject(new Error('store down')),
    });

    expectGolden(pinned, golden.persistenceBankingFailed);
  });

  it('should start each CLI with the arguments the probe method names', async () => {
    const argv = {
      claudeCode: await argvOf('claude_code'),
      codexPinned: await argvOf('codex', {
        AEO_CODEX_PROBE_MODEL: 'gpt-5.6-sol',
      }),
      codexDefault: await argvOf('codex'),
      cursor: await argvOf('cursor'),
    };

    expectGolden(argv, golden.argv);
  });
});

describe('agent-clis - runCanaryProbe() golden pins', () => {
  it('should record each surface canary as a canary operation', async () => {
    const recorder = await openGoldenRecorder(root);
    const spy = spyTrace(probeTraceOf(recorder, 'canary'));
    const runtime = await host.runtime({ mode: 'ok' });
    const failures = [];

    for (const surface of ['claude_code', 'codex', 'cursor'] as const) {
      failures.push(
        await runCanaryProbe(surface, runtime, { trace: spy.trace }),
      );
    }

    const pinned = {
      failures,
      port: spy.calls(),
      journal: await readOperations(root),
    };

    expectGolden(pinned, golden.canaryPassed);
  });

  it('should record a failed canary and name every failing surface', async () => {
    const recorder = await openGoldenRecorder(root);
    const spy = spyTrace(probeTraceOf(recorder, 'canary'));
    const runtime = await host.runtime({ mode: 'auth-error' });

    const failure = await runCanaryProbe('claude_code', runtime, {
      trace: spy.trace,
    });
    const thrown = await runCanaryProbes(['claude_code', 'cursor'], runtime)
      .then(() => null)
      .catch((error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
      );

    const pinned = {
      failure,
      thrown,
      port: spy.calls(),
      journal: await readOperations(root),
    };

    expectGolden(pinned, golden.canaryFailed);
  });
});
