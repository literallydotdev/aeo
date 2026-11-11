import type { z } from 'zod';
import { recommendedModelId } from '../models/supported-models';
import { auditFileVersion, type auditFileSchema } from './audit-file';

// ============================================================================
// What `literally-aeo init` writes (specs/aeo-open-source-cli-spec.md §4.1):
// a small fictional example to edit, never a real company, and the setting
// names a run reads, without values.
// ============================================================================

export const exampleAuditFile = {
  version: auditFileVersion,
  model: recommendedModelId,
  brand: {
    name: 'Northwind Data',
    domain: 'northwind.example',
    aliases: ['Northwind'],
  },
  competitors: [
    { name: 'Contoso Analytics', domain: 'contoso.example', aliases: [] },
    { name: 'Fabrikam Cloud', domain: 'fabrikam.example', aliases: [] },
  ],
  sections: [
    {
      key: 'managed_databases',
      prompts: [
        {
          id: 'md1',
          text: 'Which managed Postgres services suit a small engineering team?',
          category: 'product_recommendation',
        },
        {
          id: 'md2',
          text: 'What is the most cost-effective way to run a production database without a DBA?',
          category: 'problem_solving',
        },
      ],
    },
  ],
  surfaces: ['chatgpt', 'gemini', 'claude', 'perplexity'],
  // The market the search surfaces are placed in: the defaults, shown so
  // they are there to edit.
  geography: 'us',
  language: 'en',
  moneyPages: ['https://northwind.example/pricing'],
  productBrief:
    'Northwind Data is a managed Postgres service for small teams: automatic backups, branching and usage-based pricing.',
  grounding: 'full',
  runPolicy: {
    maxPlannedUnits: 100,
    // No dollar cap here: approve one per run with `run --max-usd`, after
    // `literally-aeo plan` shows the estimate. It caps every paid call.
    budget: { maxHours: 12 },
  },
} satisfies z.input<typeof auditFileSchema>;

export const exampleEnvFile = `# Settings literally-aeo reads. Keep this file out of source control.
# The process environment wins over values set here.

# Every chat surface, every workflow stage and the host's model calls.
AI_GATEWAY_API_KEY=

# Google AI Overviews (the google_ai_overview surface), the consumer apps
# (chatgpt_app, google_ai_mode) and the search that full grounding
# researches product claims with.
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=

# Coding-agent surfaces. Leave empty to use the CLI's own login on this
# machine; a canary checks it before any paid work.
CLAUDE_CODE_OAUTH_TOKEN=
OPENAI_API_KEY=
CURSOR_API_KEY=
`;
