import { recorded, type ExecutionRecorder } from '../bundle/recorder';
import {
  createHostPacer,
  guardedRequest,
  type SiteRequest,
} from '../grounding/guarded-request';
import type { AeoAuditConfig, AeoTechnicalChecks } from '../schema';
import type { PartialFailure } from '../probes/web-tool-guard';
import { checkLlmsTxt, runCrawlerAccessCheck } from './crawler-access';
import { runRenderabilityCheck } from './renderability';

// ============================================================================
// Check phase (hardening spec §4.3): the technical AEO checks over the
// client's site, returning their own failures instead of pushing into a
// shared list. Injected into the runner so the golden replay and unit tests
// run with a stub — checks are live fetches and a Playwright browser.
// ============================================================================

// At most one request at a time per host, this far apart, across every check
// of the phase (specs/aeo-checks-and-reach-spec.md §3.1).
const hostIntervalInMs = 1000;

export type CheckPhaseResult = {
  checks: AeoTechnicalChecks;
  failures: PartialFailure[];
};

export const runTechnicalChecks = async (
  config: AeoAuditConfig,
  recorder?: ExecutionRecorder,
): Promise<CheckPhaseResult> => {
  const failures: PartialFailure[] = [];
  const pace = createHostPacer(hostIntervalInMs);
  const request: SiteRequest = (options) => {
    return guardedRequest({ ...options, pace });
  };

  // One operation per check, with its parameters and its extracted result
  // (spec §7.2). The checks' own HTTP requests and raw bodies stay inside
  // them; the export says so.
  const check = <T>(
    name: string,
    parameters: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    return recorded({
      recorder,
      start: {
        kind: 'technical_check',
        role: name,
        inputs: { parameters: JSON.stringify(parameters) },
        details: { check: name },
      },
      run,
      finish: (result) => ({
        outcome: 'succeeded',
        outputs: { result: JSON.stringify(result) },
      }),
    }).catch((error: unknown) => {
      failures.push({ step: `checks:${name}`, error: String(error) });

      return null;
    });
  };

  const [crawlerAccess, llmsTxt, renderability] = await Promise.all([
    check('crawler_access', { domain: config.brand.domain }, () =>
      runCrawlerAccessCheck(config.brand.domain, request),
    ),
    check('llms_txt', { domain: config.brand.domain }, () =>
      checkLlmsTxt(config.brand.domain, request),
    ),
    check('renderability', { moneyPages: config.moneyPages }, () =>
      runRenderabilityCheck(config.moneyPages, { request, pace }),
    ),
  ]);

  return {
    checks: {
      crawlerAccess,
      llmsTxt,
      renderability,
      agentReadiness: config.agentReadiness ?? null,
    },
    failures,
  };
};
