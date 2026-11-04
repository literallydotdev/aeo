import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { maxAnswerChars, truncationMarker } from './answer-text';
import {
  perceptionBatchSize,
  perceptionModel,
  perceptionVersion,
  buildPerceptionSystemPrompt,
  perceptionBatchSchema,
} from './sentiment';

// ============================================================================
// Version pins (hardening spec §2.11). perceptionVersion is part of the
// perception cache key and of snapshot meta (the Codex analyze stage pins
// its own version in codex-workflow/schemas.ts), so a change to anything the model sees — the prompt template, the
// output schema, the model, the truncation rule, the batch size — must bump
// the version or every cached analysis silently replays under the wrong
// rules. The perception hash pins what its version currently means: change
// the inputs and the test fails until the version constant moves and the
// hash is re-pinned. The analyzer's prompt now lives in the Codex analyze
// stage's work-directory rules, so its version is pinned by value only.
// ============================================================================

const sha256 = (value: string): string => {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
};

describe('perceptionVersion', () => {
  it('perceptionVersion', () => {
    const fingerprint = sha256(
      JSON.stringify({
        prompt: buildPerceptionSystemPrompt('Fixture Brand', 'A brief.'),
        schema: z.toJSONSchema(perceptionBatchSchema),
        model: perceptionModel,
        batchSize: perceptionBatchSize,
        maxAnswerChars,
        truncationMarker,
      }),
    );
    expect(perceptionVersion).toBe(3);
    // Bump perceptionVersion before re-pinning this hash.
    expect(fingerprint).toBe('5f1b6ac20ffa71d9');
  });
});
