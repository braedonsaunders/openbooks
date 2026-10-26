import { cmp } from "@openbooks/engine/money/money";

/** The shortest reason the count engine accepts for a second count that differs from the first. */
export const SECOND_COUNT_REASON_MIN_LENGTH = 5;

/**
 * Whether a typed observation is still unsaved. An empty entry is not an
 * observation. A value with nothing recorded against it is unsaved, and a
 * value that differs exactly from the recorded quantity is unsaved; one that
 * matches it is saved, so an agreed count does not hold the drawer open.
 */
export function hasUnsavedObservation(typed: string, recorded: string | null): boolean {
  const value = typed.trim();
  if (value === "") return false;
  if (recorded === null) return true;
  try {
    return cmp(value, recorded) !== 0;
  } catch {
    return true;
  }
}

/**
 * Whether a second observation must be explained before it is recorded.
 *
 * The rule matches the engine's confirmation check: a second count that differs
 * from the first needs a reason, while one that agrees does not. A value that
 * cannot be compared exactly (more decimal places than the money scale, or
 * unparseable text) counts as differing, so the reason is asked for and the
 * server returns the precise refusal instead of this check guessing.
 */
export function secondObservationNeedsReason(observed: string, first: string | null): boolean {
  if (first === null) return true;
  try {
    return cmp(observed, first) !== 0;
  } catch {
    return true;
  }
}
