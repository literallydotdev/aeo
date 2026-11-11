import { z } from 'zod';
import {
  aeoAuditConfigSchema,
  aeoSectionConfigSchema,
  agentProbeConfigSchema,
  authoredSurfacesSchema,
} from '../schema';
import { proposedProductFactSchema } from '../grounding/schema';

// ============================================================================
// What the config author produces: the config draft (the audit config minus
// the fields the host owns) and its notes. Kept apart from the validation so
// the Codex workflow's stage table can name the shape without pulling the
// validator's network code into every bundle that imports the stage list.
// ============================================================================

export const authorOutputSchema = aeoAuditConfigSchema
  .omit({
    reportKey: true,
    slug: true,
    agentReadiness: true,
    sourceOverrides: true,
    productGrounding: true,
    competitorQualification: true,
    // Depth decides what a run costs, so the operator sets it in audit.json
    // with the estimate in front of them, never the author.
    chatProbes: true,
    // A custom surface is a model the operator chooses and binds; the
    // author could name one and bind nothing.
    customSurfaces: true,
  })
  .extend({
    // The author decides the coding agents. The consumer apps are opted
    // into by the operator, in audit.json or the hosted config.
    surfaces: authoredSurfacesSchema,
    // The agent batch the author could always propose: 1 or 2 runs per
    // prompt. A deeper one is the operator's call, as chat depth is.
    agentProbes: agentProbeConfigSchema
      .extend({ runsPerPrompt: z.number().int().min(1).max(2).default(2) })
      .prefault({}),
    sections: z
      .array(
        aeoSectionConfigSchema.extend({
          key: z
            .string()
            .regex(
              /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/,
              'Section keys must form stable anchors and evidence paths',
            ),
        }),
      )
      .min(1),
  })
  .strict();

export type AuthorOutput = z.infer<typeof authorOutputSchema>;

export const authorNotesSchema = z
  .object({
    verdict: z.enum(['fit', 'not_a_fit']),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().max(2000)).max(20),
    briefContradiction: z.boolean().default(false),
    proposedFacts: z.array(proposedProductFactSchema).max(40).default([]),
  })
  .strict();

export type AuthorNotes = z.infer<typeof authorNotesSchema>;
