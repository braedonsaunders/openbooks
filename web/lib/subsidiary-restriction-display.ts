import type { SubsidiaryRestriction } from '@openbooks/schema'

/** Keep malformed stored policy distinct from unrestricted access in editors. */
export function asSubsidiaryRestriction(value: unknown): SubsidiaryRestriction | { mode: 'invalid' } {
  if (typeof value !== 'object' || value === null || !('mode' in value)) {
    return { mode: 'invalid' }
  }
  if (value.mode === 'all') return { mode: 'all' }
  if (
    value.mode === 'subtree' &&
    'subsidiaryId' in value &&
    typeof value.subsidiaryId === 'string'
  ) {
    return { mode: 'subtree', subsidiaryId: value.subsidiaryId }
  }
  if (
    value.mode === 'list' &&
    'subsidiaryIds' in value &&
    Array.isArray(value.subsidiaryIds) &&
    value.subsidiaryIds.every((id): id is string => typeof id === 'string')
  ) {
    return { mode: 'list', subsidiaryIds: value.subsidiaryIds }
  }
  return { mode: 'invalid' }
}
