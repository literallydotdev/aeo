import { describe, expect, it } from 'vitest';
import { finalCopyDraftSchemaForSections } from './copy-schema';

const block = (text: string, basisFactIds: string[]) => {
  return {
    kind: 'narrative',
    text,
    basisFactIds,
    premises: [{ proposition: text, basisFactIds }],
  };
};

/** A copy draft on the final contract. */
const draft = {
  intro: [
    block('Example appeared in one measured answer.', ['measured-count']),
  ],
  sections: { tools: { subtitle: [] } },
  hero: {
    title: block('Example appears in the measured tool recommendations', [
      'measured-count',
    ]),
    subtitle: block('Example appeared in one captured answer.', [
      'measured-count',
    ]),
  },
  confidence: 0.8,
};

describe('copy-schema - finalCopyDraftSchemaForSections()', () => {
  // Fixture from execution 01M2ASSJDA7656TSRTZ8WFNEWR (2026-09-12): the
  // third and last draft returned `sections: {}` against the open record and
  // the copy block failed only in host validation.
  it('should refuse a draft that omits a configured section', () => {
    const scoped = finalCopyDraftSchemaForSections(['typescript_api_hosting']);

    const omitted = scoped.safeParse({ ...draft, sections: {} });
    const complete = scoped.safeParse({
      ...draft,
      sections: { typescript_api_hosting: { subtitle: [] } },
    });

    expect(omitted.success).toBe(false);
    expect(complete.success).toBe(true);
  });

  it('should refuse sections outside the configuration and keeps the object strict', () => {
    const scoped = finalCopyDraftSchemaForSections(['typescript_api_hosting']);

    const unknownSection = scoped.safeParse({
      ...draft,
      sections: {
        typescript_api_hosting: { subtitle: [] },
        unknown: { subtitle: [] },
      },
    });
    const extraKey = scoped.safeParse({
      ...draft,
      sections: { typescript_api_hosting: { subtitle: [] } },
      extra: true,
    });

    expect(unknownSection.success).toBe(false);
    expect(extraKey.success).toBe(false);
  });

  it('should keep the open record when no section keys are given', () => {
    const result = finalCopyDraftSchemaForSections([]).safeParse({
      ...draft,
      sections: {},
    });

    expect(result.success).toBe(true);
  });
});
