export interface SequencedOperation {
  sequence: number;
  name: string;
  status: string;
}

/**
 * Work-order operations run in routing sequence. An operation may start only
 * after every earlier operation on the order is done. Returns the earliest
 * earlier-sequence operation that is not yet done, or null when the operation
 * may start. Routings carry no overlap flag, so the rule has no exceptions here.
 */
export function sequenceBlocker<T extends SequencedOperation>(
  operations: readonly T[],
  sequence: number,
): T | null {
  let blocker: T | null = null;
  for (const operation of operations) {
    if (operation.sequence >= sequence || operation.status === "done") continue;
    if (blocker === null || operation.sequence < blocker.sequence) blocker = operation;
  }
  return blocker;
}
