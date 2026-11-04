type CredentialScanOptions = {
  // Off for answers a probed assistant wrote: they quote example connection
  // strings (`postgres://user:pass@localhost/db`) and none of the job's own
  // secrets is one; a real leak still matches `secrets` verbatim.
  // Encore's bi9 lost 7 answers to this, 2026-10-21.
  includeConnectionStrings?: boolean;
  // Off to look only for the run's own secrets: the bundle exporter blocks
  // on those outright and treats a generic key pattern as a finding the
  // operator may accept (specs/aeo-open-source-cli-spec.md §9).
  includePatterns?: boolean;
};

const connectionStringPattern = /postgres(?:ql)?:\/\/[^\s"']+/i;

const keyPattern =
  /(?:aeo_(?:dev|prod)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16})/i;

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
