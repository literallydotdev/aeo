// ============================================================================
// Answer-text helpers shared by the analyzers and the pipeline (correctness
// spec §3.2): bounded truncation that keeps the trailing source list, and
// cited-URL extraction from the answer text only.
// ============================================================================

// Practical ceiling per answer sent to an analyzer. Agent answers run 3k–6k
// characters and the chat surfaces append their `Sources used by search:`
// block at the END, so the old 2,000-character head cut lost both late
// mentions and the whole source list.
export const maxAnswerChars = 20_000;
const truncationTailChars = 2_000;
export const truncationMarker = '\n\n[… truncated …]\n\n';

export const normalizeResponseText = (text: string): string | null => {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized || null;
};

export type TruncatedAnswer = {
  text: string;
  truncated: boolean;
  originalChars: number;
};

/**
 * Keeps the head AND the trailing 2,000 characters (where the appended
 * `Sources` block lives) when an answer exceeds the ceiling, with a visible
 * marker between them. Callers log the event with surface + prompt context.
 */
export const truncateAnswer = (
  text: string,
  maxChars: number = maxAnswerChars,
): TruncatedAnswer => {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }

  const tail = Math.min(truncationTailChars, Math.floor(maxChars / 2));
  const head = maxChars - tail;

  return {
    text: `${text.slice(0, head)}${truncationMarker}${text.slice(-tail)}`,
    truncated: true,
    originalChars: text.length,
  };
};

// Ceiling on cited URLs kept per run — a ceiling, not a routine truncation;
// the old cap of 8 undercounted source mix, cited content, and outreach on
// answers with long source lists.
export const maxCitedUrls = 64;

/**
 * Every http(s) URL in the answer text, in order of first appearance,
 * deduped by normalized form (trailing slash and utm_* params dropped) so a
 * source listed twice is not double-counted in the source mix. The ORIGINAL
 * string is kept as the stored URL; normalization is only the dedupe key.
 */
export const extractCitedUrls = (
  text: string,
  limit: number = maxCitedUrls,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  // `)` is part of a URL only while it closes a `(` inside the URL (a
  // Wikipedia-style `_(software)` path); an unbalanced one ends the URL —
  // the markdown `[text](url)` and prose `(see url)` cases (§2.10).
  // Backticks and asterisks never belong to a URL: an address inside
  // markdown inline code or emphasis kept its closing mark and produced a
  // host like "app.vercel.app`" in the source labels (run C, 2026-09-13).
  const urlRegex = /https?:\/\/[^\s"'<>\]`*]+/gi;
  let match = urlRegex.exec(text);

  while (match !== null && out.length < limit) {
    const raw = trimUnbalancedParens(match[0]).replace(/[.,;:!?]+$/, '');
    const key = citedUrlKey(raw);

    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(raw);
    }

    match = urlRegex.exec(text);
  }

  return out;
};

const trimUnbalancedParens = (url: string): string => {
  let out = url;

  for (;;) {
    const open = (out.match(/\(/g) ?? []).length;
    const close = (out.match(/\)/g) ?? []).length;

    if (close <= open) {
      return out;
    }

    const last = out.lastIndexOf(')');

    if (last === -1) {
      return out;
    }

    out = out.slice(0, last);
  }
};

/** Dedupe key for a cited URL; null when the string is not a valid URL. */
export const citedUrlKey = (raw: string): string | null => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  for (const param of [...url.searchParams.keys()]) {
    if (param.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(param);
    }
  }

  url.hash = '';

  const search = url.searchParams.toString();
  const pathname = url.pathname.replace(/\/+$/, '');

  return `${url.protocol}//${url.host.toLowerCase()}${pathname}${
    search ? `?${search}` : ''
  }`;
};
