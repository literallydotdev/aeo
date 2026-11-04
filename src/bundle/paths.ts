// ============================================================================
// Bundle paths (specs/aeo-open-source-cli-spec.md §8.1): relative POSIX
// paths over a restricted lowercase ASCII set, built by the exporter. No
// free-form string (a section key, a prompt id) ever becomes a segment, so
// traversal, case folding and Unicode normalization cannot make two entries
// collide or one escape the bundle.
// ============================================================================

const segmentPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const maxPathLength = 512;
const maxSegments = 8;

/** bundlePathError names what is wrong with a bundle path, or undefined. */
export const bundlePathError = (candidate: string): string | undefined => {
  if (candidate.length === 0 || candidate.length > maxPathLength) {
    return `path length ${candidate.length} is outside 1 to ${maxPathLength}`;
  }

  if (candidate.startsWith('/') || candidate.includes('\\')) {
    return 'path is absolute or uses a backslash';
  }

  const segments = candidate.split('/');

  if (segments.length > maxSegments) {
    return `path has more than ${maxSegments} segments`;
  }

  const invalid = segments.find((segment) => !segmentPattern.test(segment));

  if (invalid !== undefined) {
    return `segment ${JSON.stringify(invalid)} is outside the allowed set`;
  }

  return undefined;
};
