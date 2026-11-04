import { createHash } from 'node:crypto';
import { strictCanonicalJson } from '../lib/canonical-json';

// ============================================================================
// JSON as the bundle reads and hashes it (specs/aeo-open-source-cli-spec.md
// §8.1). JSON.parse keeps the last of two duplicate keys, so a bundle could
// show one value to a reader and hash another; the verifier reads every
// bundle document through parseBundleJson, which refuses duplicates.
// ============================================================================

export const sha256Hex = (bytes: string | Uint8Array): string => {
  return createHash('sha256').update(bytes).digest('hex');
};

/** sha256 over the strict canonical form of a JSON value. */
export const canonicalDigest = (value: unknown): string => {
  return sha256Hex(strictCanonicalJson(value));
};

const whitespace = new Set([' ', '\t', '\n', '\r']);

/** Walks JSON text structurally, refusing a duplicate key in any object.
 * JSON.parse still produces the value, so the two never disagree on what
 * a valid document means. */
const assertNoDuplicateKeys = (text: string): void => {
  let at = 0;

  const skipWhitespace = () => {
    while (at < text.length && whitespace.has(text.charAt(at))) {
      at += 1;
    }
  };

  const readString = (): string => {
    const start = at;

    at += 1;

    while (at < text.length && text.charAt(at) !== '"') {
      at += text.charAt(at) === '\\' ? 2 : 1;
    }

    at += 1;

    const decoded: unknown = JSON.parse(text.slice(start, at));

    if (typeof decoded !== 'string') {
      throw new Error(`Invalid JSON string at offset ${start}.`);
    }

    return decoded;
  };

  const readValue = (): void => {
    skipWhitespace();

    const char = text.charAt(at);

    if (char === '{') {
      const keys = new Set<string>();

      at += 1;
      skipWhitespace();

      if (text.charAt(at) === '}') {
        at += 1;

        return;
      }

      for (;;) {
        skipWhitespace();

        const keyAt = at;
        const key = readString();

        if (keys.has(key)) {
          throw new Error(
            `Duplicate JSON key ${JSON.stringify(key)} at offset ${keyAt}.`,
          );
        }

        keys.add(key);
        skipWhitespace();
        at += 1;
        readValue();
        skipWhitespace();

        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }

        at += 1;

        return;
      }
    }

    if (char === '[') {
      at += 1;
      skipWhitespace();

      if (text.charAt(at) === ']') {
        at += 1;

        return;
      }

      for (;;) {
        readValue();
        skipWhitespace();

        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }

        at += 1;

        return;
      }
    }

    if (char === '"') {
      readString();

      return;
    }

    while (at < text.length && !',]}'.includes(text.charAt(at))) {
      at += 1;
    }
  };

  readValue();
};

/** parseBundleJson parses a bundle document, refusing duplicate keys. */
export const parseBundleJson = (text: string): unknown => {
  // JSON.parse first: it reports malformed text precisely, and the walk
  // below may then assume well-formed input.
  const value: unknown = JSON.parse(text);

  assertNoDuplicateKeys(text);

  return value;
};

/** encodeBundleJson is how the exporter writes a JSON document: readable
 * bytes whose value is what the digests cover. */
export const encodeBundleJson = (value: unknown): Buffer => {
  // Validates that the value has a canonical form before writing it.
  strictCanonicalJson(value);

  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
};
