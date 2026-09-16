/**
 * Pure line model for the split-lines editor (no JSX): coding keys, the
 * `AllocationLine` shape, and the line ↔ allocation-target-basis mappings.
 * Lives in `.ts` so unit tests run under plain `node --test` (Node strips
 * types from `.ts` but not `.tsx`); `SplitLinesEditor.tsx` re-exports this
 * module, so existing consumers keep importing from the component.
 */

export type CodingKey = 'department' | 'project' | 'location' | 'class' | 'tax' | 'party'

export const CODING_FIELD: Record<CodingKey, keyof AllocationLine> = {
  department: 'departmentId',
  project: 'projectId',
  location: 'locationId',
  class: 'classId',
  tax: 'taxCodeId',
  party: 'partyId',
}

export interface CodingConfig {
  key: CodingKey
  label: string
  options: { value: string; label: string }[]
}

export interface AllocationLine {
  accountId: string
  // Fixed amounts and manual weights stay as their exact decimal text while
  // they are being edited. Converting every keystroke through Number loses
  // precision before the server-side money validator can canonicalize the value.
  portion:
    | { kind: 'remainder' }
    | { kind: 'percent'; value: number }
    | { kind: 'fixed'; value: string }
    | { kind: 'weight'; value: string }
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  taxCodeId?: string | null
  partyId?: string | null
  description?: string | null
  /** Allocation target label (the rule drawer shows it beside the share). */
  label?: string | null
}

/**
 * The target-basis half of an allocation line: everything the allocation
 * kernel's explicit targets carry beyond the dimension coordinate. The rule
 * drawer serializes editor lines through `allocationTargetBasisFromLine`
 * (dimensions map one-to-one); an empty account means "same account".
 */
export interface AllocationTargetBasis {
  targetAccountId: string | null
  fixedPercent: string | null
  weight: string | null
  isRemainder: boolean
  label: string | null
}

export function allocationTargetBasisFromLine(line: AllocationLine): AllocationTargetBasis {
  const base = {
    targetAccountId: line.accountId === '' ? null : line.accountId,
    label: line.label ?? null,
  }
  switch (line.portion.kind) {
    case 'remainder':
      return { ...base, fixedPercent: null, weight: null, isRemainder: true }
    case 'percent':
      return { ...base, fixedPercent: String(line.portion.value), weight: null, isRemainder: false }
    case 'weight':
      return { ...base, fixedPercent: null, weight: line.portion.value, isRemainder: false }
    case 'fixed':
      // Fixed-amount splits belong to entry/bank surfaces, not allocation
      // targets — the drawer never offers the kind, but the mapping stays
      // total so a misconfigured line fails closed at publish, not silently.
      return { ...base, fixedPercent: null, weight: null, isRemainder: false }
  }
}

export function newAllocationLine(accountId = ''): AllocationLine {
  return { accountId, portion: { kind: 'remainder' } }
}

/** Convert an amount input without coercing fixed money through IEEE-754. */
export function allocationPortionFromInput(
  portion: AllocationLine['portion'],
  rawValue: string,
): AllocationLine['portion'] {
  if (portion.kind === 'fixed') return { kind: 'fixed', value: rawValue }
  if (portion.kind === 'weight') return { kind: 'weight', value: rawValue }
  if (portion.kind === 'percent') return { kind: 'percent', value: Number(rawValue) || 0 }
  return portion
}
