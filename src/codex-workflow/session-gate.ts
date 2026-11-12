import { ModelBudgetError } from '../models/accounting';

// ============================================================================
// A session is reserved at its high estimate before it starts, and a stage
// starts its sessions together. A cap near what the run will really cost
// then holds the first reservations and refuses the next, and the run
// stopped with most of its cap unspent (a recorded run, 2026-11-12: $1.56
// spent of $5.00). A session the cap cannot hold yet now waits for a running
// one to finish and settle at what it used, then asks again. It is refused,
// as before, when no session is running: nothing more can be given back.
//
// The gate counts sessions, not ledger entries: a session always ends, by
// its timeout if nothing else, while a call with an unknown outcome keeps
// its reservation for good and would be waited on for ever.
// ============================================================================

type Gate = { running: number; waiting: Array<() => void> };

const gates = new WeakMap<object, Gate>();

const gateOf = (ledger: object): Gate => {
  const known = gates.get(ledger);

  if (known) {
    return known;
  }

  const gate: Gate = { running: 0, waiting: [] };

  gates.set(ledger, gate);

  return gate;
};

const nextEnd = (gate: Gate, signal: AbortSignal | undefined) => {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('The run was stopped.'),
      );
    };

    // A stop that arrived while the ledger was answering is no event any
    // more: it is already the signal's state.
    if (signal?.aborted) {
      abort();

      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    gate.waiting.push(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
  });
};

export type HeldSession<Charge> = {
  charge: Charge;
  /** Called once when the session is over, whatever its outcome. */
  ended: () => void;
};

/**
 * reserveWhenAffordable makes a session's reservation against `ledger`,
 * waiting for a running session of the same ledger to end when the cap
 * cannot hold it yet. Every other refusal, and a refusal while nothing is
 * running, is thrown as the ledger gave it.
 */
export const reserveWhenAffordable = async <Charge>(
  ledger: object,
  reserve: () => Promise<Charge>,
  signal?: AbortSignal,
): Promise<HeldSession<Charge>> => {
  const gate = gateOf(ledger);

  for (;;) {
    signal?.throwIfAborted();

    try {
      const charge = await reserve();
      let over = false;

      gate.running += 1;

      return {
        charge,
        ended: () => {
          if (over) {
            return;
          }

          over = true;
          gate.running -= 1;

          for (const wake of gate.waiting.splice(0)) {
            wake();
          }
        },
      };
    } catch (error) {
      const exhausted =
        error instanceof ModelBudgetError && error.kind === 'exhausted';

      if (!exhausted || gate.running === 0) {
        throw error;
      }

      await nextEnd(gate, signal);
    }
  }
};
