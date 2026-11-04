import type { AeoAuditConfigInput } from '../schema';

// ============================================================================
// Literally.dev Q3 2026 baseline: the agency's own self-audit, and the worked
// example the config author is shown (src/author/examples.ts). Prompt sets
// are the quarterly re-measurement baseline: edits after the first committed
// run are a baseline reset and must be called out in the report's
// methodology note. The rationale for its sections, competitors and aliases
// is private and lives in literally-2026-q3.notes.md.
// ============================================================================

const aeoAgencyCompetitors = [
  { name: 'Discovered Labs', domain: 'discoveredlabs.com' },
  { name: 'Optimist', domain: 'yesoptimist.com' },
  { name: 'Graphite', domain: 'graphite.io' },
  { name: 'First Page Sage', domain: 'firstpagesage.com' },
];

const technicalContentCompetitors = [
  { name: 'Draft.dev', domain: 'draft.dev' },
  { name: 'Hackmamba', domain: 'hackmamba.io' },
  { name: 'Wizard on Demand', domain: 'wizardondemand.com' },
  { name: 'EveryDeveloper', domain: 'everydeveloper.com' },
];

export const literally2026Q3: AeoAuditConfigInput = {
  reportKey: 'literally-2026-q3',
  slug: 'literally-q3',
  // Aliases reach the answer analyzer (correctness spec §3.2). "Literally
  // AS" is the legal entity; "xEO" is the published method name and only
  // Literally.dev uses it. Bare "Literally" is excluded on purpose: the
  // adverb is in nearly every long answer and would count as a mention.
  // Citation matching is domain-only and strips `www.`.
  brand: {
    name: 'Literally.dev',
    domain: 'literally.dev',
    aliases: ['Literally AS', 'xEO'],
  },
  // Report-level set = union of the per-section sets; each section scores
  // only its own market.
  competitors: [...aeoAgencyCompetitors, ...technicalContentCompetitors],
  sections: [
    {
      key: 'aeo_agencies',
      competitors: aeoAgencyCompetitors,
      // Section 1 — the lead positioning. Brand-free agency-choice prompts
      // (devtool focus, the chat assistants, Europe, measuring and creating
      // in one engagement), the buyer vocabulary comparison, one
      // "alternatives to" a direct competitor, and the problems buyers
      // bring: coding-agent recommendations, measuring AI mentions, and low
      // domain authority.
      prompts: [
        {
          id: 'aa1',
          text: 'What are the best AEO agencies for developer tool companies in 2026?',
          category: 'product_recommendation',
        },
        {
          id: 'aa2',
          text: 'Which agency should a B2B SaaS startup hire to get recommended by ChatGPT, Claude, and Perplexity?',
          category: 'product_recommendation',
        },
        {
          id: 'aa3',
          text: 'Which AEO agencies based in Europe work with B2B software companies?',
          category: 'product_recommendation',
        },
        {
          id: 'aa4',
          text: 'Is there an agency that can both measure our visibility in AI assistant answers and produce the content to improve it?',
          category: 'product_recommendation',
        },
        {
          id: 'aa5',
          text: 'How do the leading answer engine optimization and generative engine optimization (GEO) agencies compare on pricing and how they measure results?',
          category: 'comparison',
        },
        {
          id: 'aa6',
          text: 'What are good alternatives to Discovered Labs for AEO at a developer-focused software company?',
          category: 'comparison',
        },
        {
          id: 'aa7',
          text: 'How do I get my developer tool recommended when engineers ask Claude Code, Cursor, or Codex which library or service to use?',
          category: 'problem_solving',
        },
        {
          id: 'aa8',
          text: 'How can I measure whether ChatGPT and other AI assistants mention my product, and then improve those mentions?',
          category: 'problem_solving',
        },
        {
          id: 'aa9',
          text: 'Our developer tool has low domain authority. How do we get cited by AI assistants in buying questions?',
          category: 'problem_solving',
        },
        {
          id: 'aa10',
          text: 'Who are the leading agencies and experts in answer engine optimization for B2B software companies?',
          category: 'industry_expert',
        },
      ],
    },
    {
      key: 'technical_content_agencies',
      competitors: technicalContentCompetitors,
      // Section 2 — the underlying identity. Brand-free agency-choice prompts
      // (devtool content, engineer-written content, the in-house-hire
      // substitute, technical documentation), one "alternatives to" the
      // category leader, a brand-free comparison on the criteria buyers
      // weigh, and the two substitutes prospects describe in their own
      // words: engineers with no time to write and AI-generated posts that
      // failed to convert.
      prompts: [
        {
          id: 'tc1',
          text: 'What are the best technical content marketing agencies for developer tools in 2026?',
          category: 'product_recommendation',
        },
        {
          id: 'tc2',
          text: 'Which content marketing agencies have real software engineers write the articles?',
          category: 'product_recommendation',
        },
        {
          id: 'tc3',
          text: 'What should a funded devtool startup use instead of hiring an in-house content marketer?',
          category: 'product_recommendation',
        },
        {
          id: 'tc4',
          text: 'Which agencies can write and keep up to date the technical documentation for a developer platform?',
          category: 'product_recommendation',
        },
        {
          id: 'tc5',
          text: 'What are good alternatives to Draft.dev for technical blog content?',
          category: 'comparison',
        },
        {
          id: 'tc6',
          text: 'How do technical content agencies compare on pricing, writer quality, and minimum commitments?',
          category: 'comparison',
        },
        {
          id: 'tc7',
          text: 'How do I keep a consistent technical blog publishing schedule when my engineers have no time to write?',
          category: 'problem_solving',
        },
        {
          id: 'tc8',
          text: 'Our AI-generated blog posts are not converting developers. What should we do instead?',
          category: 'problem_solving',
        },
        {
          id: 'tc9',
          text: 'Who are the main players in technical content marketing and developer marketing agencies?',
          category: 'industry_expert',
        },
      ],
    },
  ],
  // Canonical agent volume (2 runs per prompt, all prompts) via the schema
  // default — 19 prompts × 2 runs × 3 agent surfaces = 114 agent probes.
  // Shrink with agentProbes: { runsPerPrompt: 1 } before the first committed
  // run if the batch is too heavy for the subscription quotas; after that
  // it's a baseline reset.
  // Canonical host is www (the apex 308s to it, checked 2026-09-04). Every
  // page is statically generated Next.js, so renderability should pass; the
  // check confirms it rather than assumes it.
  moneyPages: [
    'https://www.literally.dev/',
    'https://www.literally.dev/aeo-services',
    'https://www.literally.dev/technical-content',
    'https://www.literally.dev/technical-documentation',
    'https://www.literally.dev/compare',
    'https://www.literally.dev/aeo-analysis',
  ],
  productBrief:
    'Literally.dev (literally.dev; legal entity Literally AS) is an AEO and content marketing agency for tech companies, based in Oslo, Norway, and founded in 2024 by Andrei Gaspar. It positions as the technical content marketing agency that makes a product the brand AI assistants recommend: content written by real engineers, distributed where developers look. Three services are cataloged: AEO (answer engine optimization), technical content (blog posts, tutorials, video), and technical documentation. Content is written by hand-vetted engineers, not generalist writers; the one published selectivity figure is that it works with the top 2.7% of experts. AEO is measured, not guessed: its xEO pipeline probes brand visibility across eight surfaces (the chat assistants ChatGPT, Claude, Gemini, Perplexity, and Google AI Overviews, plus the coding agents Claude Code, Codex, and Cursor run headless as the real products) and reports mentions, citations, and share of voice per surface. Distribution and placement through a third-party publication and newsletter network is part of the service, not an add-on. Published pricing: the Sprint offer at $4,990 per month with a 3-month minimum, 10% off for a 6-month commitment, and 15% off for 12 months. Published clients include QA.tech, AppSignal, Aviator, Superlinked, Vijil, Kapa.ai, GlassFlow, Hatchet, Estuary, Adaline, Clix, Wasp.sh, DevZero, and Superplane. Published results: AppSignal saw a 5× per-visitor conversion rate versus its earlier blog catalog with results in 3 months; QA.tech doubled organic reach in under 5 months, with 4.4× AI search mentions and 2× citations across LLM surfaces. It publishes llms.txt and llms-full.txt and has no public MCP server. It does not do PR, brand design, events, community management, or paid ads. Claims that Literally.dev is a US or UK agency, that it uses AI-generated content, that it is a freelancer marketplace or a software product, that it sells an AI-visibility monitoring tool as its product, that it does paid advertising or PR, that its pricing is unpublished or quote-only, or that it is a general-audience content agency contradict this brief.',
  // Learned-label corrections (§7.1 amendment): in-market vendors the model
  // left as earned on the 2026-09-04 run (it resolves "unsure" to earned).
  // Homepage titles checked the same day: 100Signals sells demand generation
  // to software dev agencies, Wellows is an AI-visibility platform,
  // eIntelligence and Digital Applied are AI/digital marketing agencies.
  sourceOverrides: {
    '100signals.com': 'competitor',
    'wellows.com': 'competitor',
    'eintelligenceweb.com': 'competitor',
    'digitalapplied.com': 'competitor',
  },
  // Verified 2026-09-04 (curl): www.literally.dev/llms.txt and
  // /llms-full.txt both return 200 (routes in src/app/llms.txt and
  // src/app/llms-full.txt). The site publishes no MCP server.
  agentReadiness: { mcpServer: false, llmDocs: true },
  geography: 'us',
  language: 'en',
};
