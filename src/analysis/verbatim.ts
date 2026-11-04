// ============================================================================
// Verbatim passage location. A model asked to quote an answer routinely
// drops markdown emphasis, collapses whitespace or swaps quote and dash
// glyphs; the words are still the answer's own. Matching sees through that
// formatting, and the caller stores the passage exactly as the answer has
// it, so a displayed quotation is always a literal substring of its source.
// A phrase whose words differ is not found.
// ============================================================================

const markdownMarkers = new Set(['*', '_', '`', '#', '>']);

const quoteGlyphs: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '–': '-',
  '—': '-',
  '−': '-',
};

/**
 * comparable returns the comparable form of `text` and, for each comparable
 * character, the index of the source character it came from.
 */
const comparable = (text: string): { form: string; source: number[] } => {
  let form = '';
  const source: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (markdownMarkers.has(char)) {
      continue;
    }

    if (/\s/.test(char)) {
      pendingSpace = form.length > 0;
      continue;
    }

    if (pendingSpace) {
      form += ' ';
      source.push(index);
      pendingSpace = false;
    }

    form += quoteGlyphs[char] ?? char;
    source.push(index);
  }

  return { form, source };
};

const getSourceIndex = (source: readonly number[], position: number) => {
  const index = source[position];

  if (index === undefined) {
    throw new Error(`Comparable position has no source index: ${position}.`);
  }

  return index;
};

export const locateVerbatimPassage = (
  text: string,
  phrase: string,
): string | null => {
  const needle = comparable(phrase).form;

  if (!needle) {
    return null;
  }

  if (text.includes(phrase)) {
    return phrase;
  }

  const haystack = comparable(text);
  const at = haystack.form.indexOf(needle);

  if (at < 0) {
    return null;
  }

  // The passage keeps the markdown wrapped around its ends (`**Deno**`, not
  // `Deno**`), so the quotation renders the way the answer wrote it.
  let start = getSourceIndex(haystack.source, at);
  let end = getSourceIndex(haystack.source, at + needle.length - 1) + 1;

  while (start > 0 && markdownMarkers.has(text.charAt(start - 1))) {
    start -= 1;
  }

  while (end < text.length && markdownMarkers.has(text.charAt(end))) {
    end += 1;
  }

  const passage = text.slice(start, end);

  return passage;
};
