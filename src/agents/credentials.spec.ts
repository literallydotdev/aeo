import { describe, expect, it } from 'vitest';
import { credentialDetected } from './credentials';

const exampleConnectionString =
  'Set DATABASE_URL=postgres://acme:secret@localhost:5432/app before you run it.';

// Built here, never written out: a literal in a key's format would itself be
// a finding in this repository.
const providerKey = `sk-${'a1B2'.repeat(10)}`;

describe('credentials - credentialDetected()', () => {
  it.each([
    ['at the start of the text', providerKey],
    ['after an assignment', `OPENAI_API_KEY=${providerKey}`],
    ['after a scheme word', `Authorization: Bearer ${providerKey}`],
    ['in a URL query', `https://api.example.org/v1?key=${providerKey}`],
    ['percent-encoded after a space', `Bearer%20${providerKey}`],
    [
      'on a line of its own inside a JSON string',
      JSON.stringify({ notes: `the key is\n${providerKey}` }),
    ],
    ['after a unicode escape', String.raw`key:\u0020${providerKey}`],
    ['as a project key', `sk-proj-${'a1B2'.repeat(10)}`],
    ['as an Anthropic key', `x-api-key: sk-ant-${'a1B2'.repeat(6)}`],
  ])('should flag a provider key %s', (_where, text) => {
    expect(credentialDetected(text)).toBe(true);
  });

  it('should NOT read the middle of a word in a URL slug as a provider key', () => {
    const page =
      'https://www.example.org/files/Third-Party-Risk-Assessment-Questionnaire-Template-2026.pdf';

    expect(credentialDetected(page)).toBe(false);
    expect(credentialDetected(`[the template](${page})`)).toBe(false);
    // The same slug still gives up a key that sits beside it.
    expect(credentialDetected(`${page}?token=${providerKey}`)).toBe(true);
  });

  it('should flag a connection string by default', () => {
    const detected = credentialDetected(exampleConnectionString);

    expect(detected).toBe(true);
  });

  it('should NOT flag a connection string when connection strings are excluded', () => {
    const detected = credentialDetected(exampleConnectionString, [], {
      includeConnectionStrings: false,
    });

    expect(detected).toBe(false);
  });

  it('should still flag a key format when connection strings are excluded', () => {
    const answer = `Use AKIA${'A'.repeat(16)} as the access key.`;

    const detected = credentialDetected(answer, [], {
      includeConnectionStrings: false,
    });

    expect(detected).toBe(true);
  });

  it('should still flag the caller own secret inside a connection string', () => {
    const ownSecret = 'test-own-secret-1';
    const answer = `postgres://app:${ownSecret}@db.internal:5432/app`;

    const detected = credentialDetected(answer, [ownSecret], {
      includeConnectionStrings: false,
    });

    expect(detected).toBe(true);
  });
});
