type CredentialScanOptions = {
  // Off for answers a probed assistant wrote: they quote example connection
  // strings (`postgres://user:pass@localhost/db`) and none of the job's own
  // secrets is one; a real leak still matches `secrets` verbatim.
  // A recorded run lost 7 answers to this, 2026-10-21.
  includeConnectionStrings?: boolean;
  // Off to look only for the run's own secrets: the bundle exporter blocks
  // on those outright and treats a generic key pattern as a finding the
  // operator may accept (specs/aeo-open-source-cli-spec.md §9).
  includePatterns?: boolean;
};

const connectionStringPattern = /postgres(?:ql)?:\/\/[^\s"']+/i;

// Where an `sk-` key may start: not in the middle of a word. A public URL
// whose slug held "…Risk-Assessment-…" was read as a key and blocked an
// export (2026-11-11). A letter or digit that ends an escape (`%20`, `\n`,
// `\u0020`) is not part of a word: the text is also scanned before it is
// decoded, and a key on a line of its own inside a JSON string follows one.
const keyStart = String.raw`(?:(?<![A-Za-z0-9])|(?<=%[0-9A-Fa-f]{2}|\\[nrt]|\\u[0-9A-Fa-f]{4}))`;

const keyPattern = new RegExp(
  [
    String.raw`aeo_(?:dev|prod)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`,
    String.raw`${keyStart}sk-ant-[A-Za-z0-9_-]{20,}`,
    String.raw`${keyStart}sk-(?:proj-)?[A-Za-z0-9_-]{32,}`,
    String.raw`AIza[A-Za-z0-9_-]{35}`,
    String.raw`AKIA[A-Z0-9]{16}`,
  ].join('|'),
  'i',
);

/**
 * credentialDetected scans for complete credentials, including common output
 * encodings, never prefixes.
 */
export const credentialDetected = (
  text: string,
  secrets: readonly string[] = [],
  {
    includeConnectionStrings = true,
    includePatterns = true,
  }: CredentialScanOptions = {},
): boolean => {
  const variants = new Set([text]);

  try {
    variants.add(decodeURIComponent(text));
  } catch {
    // Malformed encoding is still scanned verbatim.
  }

  variants.add(
    text.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );

  for (const match of text.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    try {
      variants.add(Buffer.from(match[0], 'base64').toString('utf8'));
    } catch {
      // Text that is not base64 is still scanned verbatim.
    }
  }

  return [...variants].some(
    (value) =>
      (includePatterns && keyPattern.test(value)) ||
      (includePatterns &&
        includeConnectionStrings &&
        connectionStringPattern.test(value)) ||
      secrets.some((secret) => secret.length >= 8 && value.includes(secret)),
  );
};
