import { recorded, type ExecutionRecorder } from '../bundle/recorder';
import type { GroundingTools } from './tools';

/**
 * recordedGroundingTools records each research tool call as an operation
 * (specs/aeo-open-source-cli-spec.md §7.2): the action as its input and the
 * tool's result as its output, which holds the search results or the fetched
 * passages the grounding reads, with the fetch's request count (redirects
 * included). A result of kind `failure` is a known outcome of the tool, so
 * the operation fails with its reason; a thrown error fails it with the
 * error.
 */
export const recordedGroundingTools = (
  tools: GroundingTools,
  recorder: ExecutionRecorder,
): GroundingTools => {
  const execute: GroundingTools['execute'] = (action, context) => {
    return recorded({
      recorder,
      start: {
        kind: 'research_tool',
        role: action.tool,
        inputs: { action: JSON.stringify(action) },
        details: { tool: action.tool, searchProvider: tools.searchProvider },
      },
      run: () => tools.execute(action, context),
      finish: (result) => ({
        outcome: result.kind === 'failure' ? 'failed' : 'succeeded',
        outputs: { result: JSON.stringify(result) },
        details: {
          resultKind: result.kind,
          ...(result.kind === 'failure' && { reason: result.reason }),
        },
      }),
      signal: context.signal,
    });
  };

  return { searchProvider: tools.searchProvider, execute };
};
