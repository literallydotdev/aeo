export type ReportCopyPresentation = 'generated' | 'authored';

export const reportCopyPresentation = (
  provenanceKind: unknown,
): ReportCopyPresentation => {
  return provenanceKind === 'agent' ? 'generated' : 'authored';
};

/** Names and acronyms a section key or a generated title carries in lower
 * case ("typescript app hosting", "wysiwyg editors"), keyed by their
 * lower-case form. Only forms that are never an ordinary word belong here:
 * "it" and "as" stay out. */
const knownNameForms: Record<string, string> = {
  'aeo': 'AEO',
  'ai': 'AI',
  'api': 'API',
  'apis': 'APIs',
  'b2b': 'B2B',
  'b2c': 'B2C',
  'cd': 'CD',
  'ci': 'CI',
  'cli': 'CLI',
  'cms': 'CMS',
  'crm': 'CRM',
  'devops': 'DevOps',
  'erp': 'ERP',
  'gdpr': 'GDPR',
  'github': 'GitHub',
  'gitlab': 'GitLab',
  'graphql': 'GraphQL',
  'hr': 'HR',
  'iaas': 'IaaS',
  'ios': 'iOS',
  'javascript': 'JavaScript',
  'llm': 'LLM',
  'llms': 'LLMs',
  'macos': 'macOS',
  'ml': 'ML',
  'mlops': 'MLOps',
  'mysql': 'MySQL',
  'node.js': 'Node.js',
  'nodejs': 'Node.js',
  'paas': 'PaaS',
  'postgresql': 'PostgreSQL',
  'pr': 'PR',
  'saas': 'SaaS',
  'sdk': 'SDK',
  'sdks': 'SDKs',
  'seo': 'SEO',
  'typescript': 'TypeScript',
  'ui': 'UI',
  'ux': 'UX',
  'vpn': 'VPN',
  'wordpress': 'WordPress',
  'wysiwyg': 'WYSIWYG',
};

/** Sentence case without lowercasing product names or existing acronyms;
 * a known name or acronym takes its proper form wherever it stands. The
 * first word is whatever leads the title, a number included, so a title
 * like "2 factor auth" does not capitalize its second word. */
export const reportSectionTitle = (title: string): string => {
  let first = true;

  const sectionTitle = title.replace(/[\p{L}\p{N}][\p{L}\p{N}.]*/gu, (word) => {
    // A period inside a word is part of a name ("node.js"); one ending the
    // word is punctuation and stays outside the lookup ("hosting api.").
    const trailing = /\.+$/.exec(word)?.[0] ?? '';
    const lookupKey = word
      .slice(0, word.length - trailing.length)
      .toLowerCase();
    // An own-property check keeps inherited members ("constructor",
    // "tostring") from matching the table.
    const known = Object.hasOwn(knownNameForms, lookupKey)
      ? knownNameForms[lookupKey]
      : undefined;
    const isFirst = first;

    first = false;

    if (known !== undefined) {
      return `${known}${trailing}`;
    }

    return isFirst ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
  });

  return sectionTitle;
};

/** The stored audit timestamp determines the date in every reader timezone. */
export const formatReportDate = (iso: string): string => {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

export const reportPreparedBy = (
  brandName: string,
  generatedAt: string,
): string => {
  return `Prepared by Literally.dev for ${brandName}, ${formatReportDate(generatedAt)}`;
};
