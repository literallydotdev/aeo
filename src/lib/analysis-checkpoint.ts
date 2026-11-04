import { createHash } from 'node:crypto';
import type { AeoBrand } from '../schema';

// ============================================================================
// Analysis cache keys (correctness spec §3.7). The perception pass is
// nondeterministic model work, so without a cache every resume re-scored
// every section; with it a run on unchanged answers reproduces the committed
// snapshot exactly. The store behind the keys lives in src/stores/ (§4.4).
// ============================================================================
// A key hashes everything the model sees: brand identity (name, domain,
// aliases; competitor names + domains), the product brief, the answers keyed
// by surface:runIndex, and the pass version. Any change to any of them is a
// miss for that section only. Sorts inside a hash use codepoint order (never
// localeCompare): the key must agree across machines and ICU builds
// (hardening spec §2.10). The domain classifier shares `codepointCompare`
// for the same reason.

export type AnalyzerIdentity = {
  brand: AeoBrand;
  competitors: AeoBrand[];
};

const sha256 = (input: string): string => {
  return createHash('sha256').update(input).digest('hex');
};

export const codepointCompare = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
};

export const brandIdentityHash = (identity: AnalyzerIdentity): string => {
  return sha256(
    JSON.stringify({
      brand: {
        name: identity.brand.name,
        domain: identity.brand.domain,
        aliases: [...identity.brand.aliases].sort(codepointCompare),
      },
      competitors: identity.competitors
        .map((c) => ({
          name: c.name,
          domain: c.domain,
          aliases: [...c.aliases].sort(codepointCompare),
        }))
        .sort((a, b) => codepointCompare(a.domain, b.domain)),
    }),
  );
};

export const perceptionKey = (args: {
  sectionKey: string;
  identity: AnalyzerIdentity;
  productBrief: string;
  answers: ReadonlyArray<{
    surface: string;
    runIndex: number;
    promptIdx: number;
    text: string;
  }>;
  perceptionVersion: number;
  modelProfileDigest?: string;
}): string => {
  const answers = args.answers
    .map((a) => [a.surface, a.runIndex, a.promptIdx, a.text] as const)
    .sort((a, b) => {
      if (a[2] !== b[2]) {
        return a[2] - b[2];
      }

      if (a[0] !== b[0]) {
        return codepointCompare(a[0], b[0]);
      }

      return a[1] - b[1];
    });

  return [
    'perception',
    args.sectionKey,
    brandIdentityHash(args.identity),
    sha256(args.productBrief),
    sha256(JSON.stringify(answers)),
    `v${args.perceptionVersion}`,
    ...(args.modelProfileDigest ? [args.modelProfileDigest] : []),
  ].join('|');
};
