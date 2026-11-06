import { aeoAuditConfigSchema, type AeoAuditConfig } from '../schema';
import { normalizeDomain } from '../analysis/scoring';
import banlist from '../author/banlist.json';
import { canonicalResearchUrl, fetchGroundingSource } from '../grounding/fetch';
import { SourceRetrievalError } from '../grounding/guarded-request';
import { credentialDetected } from './credentials';
import {
  authorNotesSchema,
  authorOutputSchema,
  type AuthorNotes,
} from './author-schema';

export {
  authorNotesSchema,
  authorOutputSchema,
  type AuthorNotes,
  type AuthorOutput,
} from './author-schema';

/** What the author session read, for the rules that hold the config to its
 * research: a fact may cite only a page the session fetched, a competitor
 * should appear somewhere the session read, and a session that read nothing
 * is flagged for a person. */
export type AuthorResearchEvidence = {
  /** Every URL a successful fetch or render requested or landed on. */
  fetchedUrls: readonly string[];
  /** The saved page texts, in any order. */
  documents: readonly string[];
  successfulFetches: number;
};

/** The customer's own words, for the checks that compare the config with
 * the submission: competitor support and the coding-agent decision. */
export type AuthorBriefText = {
  companyName: string;
  desiredRecommendation: string;
  competitors?: string;
  notes?: string;
};

export type AuthorValidationResult = {
  config?: AeoAuditConfig;
  flags: string[];
  errors: string[];
  fatal?: string;
  notes?: AuthorNotes;
};

export type Reachability = 'reachable' | 'unreachable' | 'unresolved';

export const checkReachability = async (
  url: string,
  signal?: AbortSignal,
): Promise<Reachability> => {
  try {
    await fetchGroundingSource({ url, signal });

    return 'reachable';
  } catch (error) {
    signal?.throwIfAborted();

    if (error instanceof SourceRetrievalError) {
      if (
        ['unsupported_content', 'too_large', 'empty_content'].includes(
          error.reason,
        )
      ) {
        return 'reachable';
      }

      if (
        error.status &&
        ([404, 410].includes(error.status) || error.status >= 500)
      ) {
        return 'unreachable';
      }

      if (error.status && [401, 403, 429].includes(error.status)) {
        return 'reachable';
      }
    }

    return 'unresolved';
  }
};

const underHost = (candidate: string, host: string): boolean => {
  return candidate === host || candidate.endsWith(`.${host}`);
};

const escapePattern = (text: string): string => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// These common attribution prefixes change the claim's subject to the brief.
// Ask for a repair rather than stripping text and potentially losing scope.
const briefClaimPrefix =
  /^(?:(?:the )?(?:(?:customer|submitted|provided|original) )?(?:brief|submission) (?:states|says|claims|describes|lists|reports|asserts|indicates)\b|(?:according to|based on) (?:the )?(?:(?:customer|submitted|provided|original) )?(?:brief|submission)\b|unknown at submission\b)/i;

/** Software-delivery vocabulary: a brief or research that carries it names
 * technical buyers, and a `skip` decision contradicts it (surface-selection
 * spec §3.4). */
const softwareDeliveryVocabulary =
  /\b(?:APIs?|SDKs?|developers?|docs|documentation|GitHub|npm|CLI|cloud|infrastructure|Kubernetes|CI|deploy|security|observability|databases?|integrations?)\b/i;

/** An audience a coding agent is never asked about. */
const nonTechnicalAudience =
  /\b(?:consumers?|shoppers?|artists?|creatives?|hobbyists?|patients?|homeowners?|restaurants?|clinics?|families|parents|students)\b/i;

const canonicalUrl = (value: string): string | null => {
  try {
    return canonicalResearchUrl(value);
  } catch {
    return null;
  }
};

/**
 * checkAuthorResearch applies the rules that hold a config to the session's
 * research (Codex author spec §5): facts cite only fetched pages (a repairable
 * error), a competitor the research never saw is flagged, and so is a session
 * that read nothing.
 */
export const checkAuthorResearch = (args: {
  config: Pick<AeoAuditConfig, 'competitors' | 'sections'>;
  notes: AuthorNotes;
  research: AuthorResearchEvidence;
  brief?: AuthorBriefText;
}): { errors: string[]; flags: string[] } => {
  const errors: string[] = [];
  const flags = new Set<string>();
  const fetched = new Set(
    args.research.fetchedUrls.flatMap((url) => canonicalUrl(url) ?? []),
  );
  args.notes.proposedFacts.forEach((fact, index) => {
    const unread = fact.sourceUrls.filter(
      (url) => !fetched.has(canonicalUrl(url) ?? ''),
    );

    if (unread.length) {
      errors.push(
        `proposedFacts.${index}.sourceUrls: cite only what you read; never fetched or rendered in this session: ${unread.join(', ')}`,
      );
    }
  });

  if (args.research.successfulFetches === 0) {
    flags.add('research_empty');
  }

  const corpus = [
    args.brief?.desiredRecommendation,
    args.brief?.competitors,
    args.brief?.notes,
    ...args.research.documents,
  ]
    .filter((text): text is string => Boolean(text))
    .join('\n')
    .toLowerCase();
  // A competitor is supported by its name or domain in the brief or a
  // saved page's text, or by the session having read the competitor's own
  // site (a page under its domain).
  const readHosts = args.research.fetchedUrls.flatMap((url) => {
    try {
      return [new URL(url).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
  const competitors = [
    ...args.config.competitors,
    ...args.config.sections.flatMap((section) => section.competitors ?? []),
  ];

  for (const competitor of competitors) {
    const domain = normalizeDomain(competitor.domain).toLowerCase();
    const forms = [competitor.name.trim().toLowerCase(), domain].filter(
      Boolean,
    );
    const supported =
      forms.some((form) => corpus.includes(form)) ||
      readHosts.some((host) => underHost(host, domain));

    if (!supported) {
      flags.add('competitors_unsupported');
    }
  }

  return { errors, flags: [...flags].sort() };
};

/**
 * codingAgentsContradiction checks the coding-agent decision against its
 * evidence (surface-selection spec §3.4): `skip` beside software-delivery
 * vocabulary, or `measure` for an audience that never opens a terminal, asks
 * for a human look.
 */
export const codingAgentsContradiction = (args: {
  decision: 'measure' | 'skip';
  brief: AuthorBriefText;
  documents?: readonly string[];
}): boolean => {
  const everything = [
    args.brief.desiredRecommendation,
    args.brief.competitors,
    args.brief.notes,
    ...(args.documents ?? []),
  ]
    .filter((text): text is string => Boolean(text))
    .join('\n');
  const technical = softwareDeliveryVocabulary.test(everything);

  if (args.decision === 'skip') {
    return technical;
  }

  return (
    !technical && nonTechnicalAudience.test(args.brief.desiredRecommendation)
  );
};

export const validateAuthorOutput = async (args: {
  output: unknown;
  notes: unknown;
  reportKey: string;
  slug: string;
  website: string;
  protectedClientHosts: string[];
  confidenceThreshold?: number;
  reachability?: (url: string) => Promise<Reachability>;
  secrets?: readonly string[];
  signal?: AbortSignal;
  /** What the author session read; absent for an author without research. */
  research?: AuthorResearchEvidence;
  /** The submission's own words, for the checks that compare against it. */
  brief?: AuthorBriefText;
}): Promise<AuthorValidationResult> => {
  const flags = new Set<string>();
  const errors: string[] = [];

  if (
    credentialDetected(
      JSON.stringify({ output: args.output, notes: args.notes }),
      args.secrets,
    )
  ) {
    return {
      flags: [],
      errors: ['Credential-shaped output detected'],
      fatal: 'credential_detected',
    };
  }

  const output = authorOutputSchema.safeParse(args.output);
  const notes = authorNotesSchema.safeParse(args.notes);

  if (!output.success || !notes.success) {
    return {
      flags: [],
      errors: [
        ...(!output.success ? output.error.issues : []),
        ...(!notes.success ? notes.error.issues : []),
      ].map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const config = aeoAuditConfigSchema.parse({
    ...output.data,
    reportKey: args.reportKey,
    slug: args.slug,
  });
  const host = normalizeDomain(args.website);
  const competitors = [
    ...config.competitors,
    ...config.sections.flatMap((section) => section.competitors ?? []),
  ];

  if (
    !underHost(normalizeDomain(config.brand.domain), host) ||
    config.moneyPages.some((url) => !underHost(normalizeDomain(url), host)) ||
    competitors.some((competitor) =>
      args.protectedClientHosts.some((client) =>
        underHost(normalizeDomain(competitor.domain), normalizeDomain(client)),
      ),
    )
  ) {
    return {
      flags: [],
      errors: [
        'Brand/money pages must belong to the submitted host; other client brands cannot be competitors',
      ],
      fatal: 'brief_mismatch',
    };
  }

  // Repairable only once the submission is the right company's: a wrong
  // host with one attributed claim must not spend a repair session first.
  notes.data.proposedFacts.forEach((fact, index) => {
    if (briefClaimPrefix.test(fact.proposition.trim())) {
      errors.push(
        `proposedFacts.${index}.proposition: State a direct product or service claim for website verification. Move statements about the brief, provenance and unknowns to reasons; preserve product conditions and time scope.`,
      );
    }
  });

  if (args.research) {
    const researched = checkAuthorResearch({
      config,
      notes: notes.data,
      research: args.research,
      brief: args.brief,
    });
    errors.push(...researched.errors);

    for (const flag of researched.flags) {
      flags.add(flag);
    }
  }

  if (errors.length) {
    return { flags: [], errors };
  }

  if (
    args.brief &&
    codingAgentsContradiction({
      decision: config.surfaces.codingAgents,
      brief: args.brief,
      documents: args.research?.documents,
    })
  ) {
    flags.add('coding_agents_contradiction');
  }

  if (notes.data.confidence < (args.confidenceThreshold ?? 0.8)) {
    flags.add('low_confidence');
  }

  if (notes.data.briefContradiction) {
    flags.add('brief_contradiction');
  }

  // One market per config; two only for a stated reason (a repositioning,
  // two focus products). More is a reviewer's call, never automatic.
  if (config.sections.length > 2) {
    flags.add('section_count_out_of_range');
  }

  for (const section of config.sections) {
    if ((section.competitors ?? config.competitors).length < 2) {
      flags.add('few_competitors');
    }

    if (section.prompts.length < 6 || section.prompts.length > 12) {
      flags.add('prompt_count_out_of_range');
    }

    const names = [config.brand.name, ...config.brand.aliases].filter(Boolean);

    for (const prompt of section.prompts) {
      if (
        names.some((name) =>
          new RegExp(`\\b${escapePattern(name)}\\b`, 'i').test(prompt.text),
        ) ||
        names.some((name) =>
          banlist.awarenessPatterns.some((pattern) =>
            prompt.text
              .toLowerCase()
              .includes(pattern.replace('{brand}', name.toLowerCase())),
          ),
        )
      ) {
        flags.add('brand_awareness_prompt_detected');
      }
    }
  }

  const reach =
    args.reachability ?? ((url: string) => checkReachability(url, args.signal));
  const checks = [
    ...[
      ...new Set(
        competitors.map((competitor) => normalizeDomain(competitor.domain)),
      ),
    ].map((domain) => async () => {
      if ((await reach(`https://${domain}`)) === 'unresolved') {
        flags.add('competitor_domain_unresolved');
      }
    }),
    ...config.moneyPages.map((url) => async () => {
      if ((await reach(url)) !== 'reachable') {
        flags.add('money_page_unreachable');
      }
    }),
  ];
  const queue = checks.values();
  const worker = async () => {
    for (const check of queue) {
      args.signal?.throwIfAborted();
      await check();
    }
  };
  await Promise.all([worker(), worker()]);

  return { config, notes: notes.data, flags: [...flags].sort(), errors };
};
