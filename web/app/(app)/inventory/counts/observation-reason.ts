import { cmp } from '@openbooks/engine/money/money'

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
  if (first === null) return true
  try {
    return cmp(observed, first) !== 0
  } catch {
    return true
  }
}
