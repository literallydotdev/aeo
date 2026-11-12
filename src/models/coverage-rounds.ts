// ============================================================================
// Coverage rounds for batched model calls (correctness spec §3.3, "Re-ask for
// a gap, do not discard the batch"). A model asked about five items and
// answering four did four fifths of the work: the fifth is asked about again,
// alone, and the four are kept. One loop for every batched caller — the
// search analyzer, perception, domain classification, competitor
// qualification — so the rule is written once. Grounding adjudication runs
// the same loop by hand today and can adopt this when it is next touched.
//
// The rules:
//   - Every round asks only about the items still pending.
//   - An answer for an item that already has one is ignored, never a
//     replacement: a settled judgement is not reopened by a later round.
//   - The rounds stop when nothing is pending, when `maxRounds` have been
//     asked, or after a re-ask that added nothing and refused nothing. A
//     model that was asked again about a gap and still answered about none
//     of it will not answer next time; one whose answer the host refused (a
//     misquote, a wrong roster, a paraphrase) did address the item, and
//     asking again usually works.
//   - The first round is the exception: an answer that reports on nothing
//     at all is asked for once more. A reasoning model spent a whole call
//     thinking and returned an empty list for five answers (a recorded run,
//     2026-11-12); that is a failed call, not a gap the model chose.
//   - A thrown `ask` propagates. The answers merged before it stay in the
//     caller's `answered` map, so a transport failure in a later round never
//     loses an earlier round's work; the caller decides whether what it has
//     is enough.
// ============================================================================

/** What one round produced for the items it was asked about. */
export type CoverageRoundAnswers<Answer> = {
  /** Sound answers, keyed by the item's position in `items`. */
  answered: Iterable<readonly [index: number, answer: Answer]>;
  /** Items the model reported on but the host refused. They stay pending,
   * and the round counts as progress because a refusal is evidence the
   * model can address the item at all. */
  refused?: Iterable<number>;
};

export type CoverageRoundReport = {
  round: number;
  /** Items this round asked about. */
  asked: number;
  /** Items this round answered soundly. */
  added: number;
  /** Items this round reported on and the host refused. */
  refused: number;
  /** Items still without an answer after this round. */
  pending: number;
};

export type AskUntilCoveredArgs<Item, Answer> = {
  /** The whole batch, in prompt order; answers are keyed by position here. */
  items: readonly Item[];
  /** Answers settled before the first round, from an earlier attempt or a
   * cache; never asked about again. Answers are merged into this same map
   * as they arrive, which is what keeps them when `ask` throws. */
  answered?: Map<number, Answer>;
  /** The most rounds to ask, the first included. */
  maxRounds: number;
  /** One call over the items still pending, each with its position in
   * `items` so the prompt can keep whatever numbering its contract names. */
  ask: (
    pending: ReadonlyArray<{ index: number; item: Item }>,
    round: number,
  ) => Promise<CoverageRoundAnswers<Answer>>;
  /** Observability, called after every round. */
  onRound?: (report: CoverageRoundReport) => void;
};

export type AskUntilCoveredResult<Answer> = {
  /** The caller's map, or a fresh one, with every sound answer. */
  answered: Map<number, Answer>;
  /** Positions in `items` still without an answer. */
  pending: number[];
  /** Rounds actually asked. */
  rounds: number;
};

export const askUntilCovered = async <Item, Answer>(
  args: AskUntilCoveredArgs<Item, Answer>,
): Promise<AskUntilCoveredResult<Answer>> => {
  const answered = args.answered ?? new Map<number, Answer>();
  const pendingOf = () => {
    return args.items.flatMap((item, index) =>
      answered.has(index) ? [] : [{ index, item }],
    );
  };
  let pending = pendingOf();
  let rounds = 0;

  while (pending.length > 0 && rounds < args.maxRounds) {
    rounds += 1;
    const asked = new Set(pending.map((entry) => entry.index));
    const returned = await args.ask(pending, rounds);
    let added = 0;

    for (const [index, answer] of returned.answered) {
      if (!asked.has(index) || answered.has(index)) {
        continue;
      }

      answered.set(index, answer);
      added += 1;
    }

    let refused = 0;

    for (const index of returned.refused ?? []) {
      if (asked.has(index) && !answered.has(index)) {
        refused += 1;
      }
    }

    pending = pendingOf();
    args.onRound?.({
      round: rounds,
      asked: asked.size,
      added,
      refused,
      pending: pending.length,
    });

    if (added === 0 && refused === 0 && rounds > 1) {
      break;
    }
  }

  return { answered, pending: pending.map((entry) => entry.index), rounds };
};
