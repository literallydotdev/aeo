import { describe, expect, it } from 'vitest';
import { credentialDetected } from './credentials';

const exampleConnectionString =
  'Set DATABASE_URL=postgres://encore:secret@localhost:5432/app before you run it.';

describe('credentials - credentialDetected()', () => {
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
