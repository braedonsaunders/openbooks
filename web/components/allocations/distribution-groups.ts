/**
 * Entry-mode distribution groups — db-free render model shared by the line
 * grid and the document drawer.
 *
 * An exploded document line is replaced by N child `document_lines` sharing
 * one `distribution_group_id` (design docs/design/allocation-kernel.md §3,
 * `entry.ts`). The children are REAL lines: the read-only view and the PDF
 * render them untouched. This module is the edit-mode view model only:
 * grouping, group totals, the share-preserving re-explode used by the
 * editable group total, lock semantics, and un-split collapse.
 *
 * Money moves through `engine/src/money.ts` bigint helpers only — never
 * floats, never `Number(amount)` arithmetic.
 */

import { add, cmp, fromUnits, mulPercent, sum, toUnits } from '@openbooks/engine/src/money.ts'

/** Minimal row shape the group model reads. LineGrid rows and drawer LineRows both satisfy it. */
export interface DistributionGroupRow {
  distributionGroupId?: string | null
  distributionLocked?: boolean | null
  amount?: string | null
}

/** One entry-mode rule offered for a line, as returned by entry-candidates. */
export interface EntryDistributionCandidate {
  ruleId: string
  ruleKey: string
  ruleName: string
  applyPolicy: 'automatic' | 'suggest' | 'manual'
  versionId: string
  recommended: boolean
}

/** Stable blank: a row with no (or a blank) group id stands alone. */
export function groupIdOf(row: DistributionGroupRow): string | null {
  const raw = row.distributionGroupId
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/** Every row that belongs to `groupId`, in grid order, with grid indexes. */
export function groupMembers<Row extends DistributionGroupRow>(
  rows: readonly Row[],
  groupId: string,
): { row: Row; index: number }[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => groupIdOf(row) === groupId)
}

/** Distinct group ids in first-appearance order. */
export function groupIdsInOrder<Row extends DistributionGroupRow>(rows: readonly Row[]): string[] {
  const seen: string[] = []
  for (const row of rows) {
    const id = groupIdOf(row)
    if (id !== null && !seen.includes(id)) seen.push(id)
  }
  return seen
}

/** Display total of a group: Σ(child amounts). Blank cells count as zero so a
 * half-typed group still shows a running total; the save boundary keeps
 * rejecting malformed amounts exactly as it does for ungrouped lines. */
export function groupTotal<Row extends DistributionGroupRow>(members: readonly Row[]): string {
  return sum(
    members.map((row) => {
      const raw = String(row.amount ?? '').trim()
      if (raw === '') return '0.0000'
      try {
        return add(raw, '0')
      } catch {
        return '0.0000'
      }
    }),
  )
}

/**
 * A locked group is hand-edited: no later amount change re-explodes it
 * (schema `distribution_locked`). One locked child locks the whole group —
 * partially re-exploding a group the operator hand-tuned would silently
 * discard their edits.
 */
export function isGroupLocked<Row extends DistributionGroupRow>(members: readonly Row[]): boolean {
  return members.some((row) => row.distributionLocked === true)
}

/**
 * Share-preserving re-explode for the editable group total: children keep
 * their current proportions of the group, so Σ(next) == `total` exactly.
 * The largest-share child absorbs the rounding remainder (the kernel's
 * default `largest_share` residual policy), which keeps the operation
 * deterministic. A zero/empty group total puts the whole amount on the
 * first child (`first_target` fallback) instead of dividing by zero.
 */
export function reapportionGroupTotal(amounts: readonly string[], total: string): string[] {
  if (amounts.length === 0) return []
  const totalUnits = toUnits(total)
  const weightUnits = amounts.map((raw) => {
    const text = raw.trim() === '' ? '0' : raw
    return toUnits(text)
  })
  const weightTotal = weightUnits.reduce((acc, w) => acc + (w < 0n ? -w : w), 0n)
  if (weightTotal === 0n) {
    return amounts.map((_, i) => (i === 0 ? fromUnits(totalUnits) : fromUnits(0n)))
  }
  const sign = totalUnits < 0n ? -1n : 1n
  const magnitude = totalUnits < 0n ? -totalUnits : totalUnits
  // Largest remainder over magnitudes; the sign rides along afterwards so a
  // negative group total keeps every child non-positive like its source.
  const floors = weightUnits.map((w) => {
    const mag = w < 0n ? -w : w
    return (magnitude * mag) / weightTotal
  })
  const remainders = weightUnits.map((w, i) => {
    const mag = w < 0n ? -w : w
    return { i, rem: (magnitude * mag) % weightTotal, mag }
  })
  let placed = floors.reduce((acc, f) => acc + f, 0n)
  let leftover = magnitude - placed
  // Deterministic: largest fractional remainder first, ties break to the
  // largest share, then to grid order.
  const order = [...remainders].sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1
    if (a.mag !== b.mag) return a.mag > b.mag ? -1 : 1
    return a.i - b.i
  })
  for (const slot of order) {
    if (leftover <= 0n) break
    floors[slot.i] = floors[slot.i]! + 1n
    placed += 1n
    leftover -= 1n
  }
  return floors.map((f) => fromUnits(sign * f))
}

/**
 * Un-split collapse: the group folds back into ONE line at the first child's
 * coordinates carrying the group total. Returns the surviving grid index and
 * the collapsed amount; the caller rebuilds the row (clearing every
 * distribution field).
 */
export function unsplitGroup<Row extends DistributionGroupRow>(
  rows: readonly Row[],
  groupId: string,
): { keepIndex: number; total: string } | null {
  const members = groupMembers(rows, groupId)
  if (members.length === 0) return null
  const first = members[0]!
  return { keepIndex: first.index, total: groupTotal(members.map((m) => m.row)) }
}

/**
 * Edit-mode view model for one distribution group header: the synthetic row
 * the grid renders above a group's first child. `ruleName` is null until the
 * read path starts joining it (A4); the header still renders with the total.
 */
export interface GroupHeaderModel {
  key: string
  firstIndex: number
  memberCount: number
  total: string
  locked: boolean
  ruleName: string | null
}

export function groupHeaderModels<Row extends DistributionGroupRow>(
  rows: readonly Row[],
  opts: {
    totalOf?: (members: Row[]) => string
    lockedOf?: (members: Row[]) => boolean
    ruleNameOf?: (member: Row) => string | null
  } = {},
): GroupHeaderModel[] {
  const models: GroupHeaderModel[] = []
  for (const key of groupIdsInOrder(rows)) {
    const members = groupMembers(rows, key)
    const first = members[0]
    if (!first) continue
    const memberRows = members.map((m) => m.row)
    models.push({
      key,
      firstIndex: first.index,
      memberCount: members.length,
      total: opts.totalOf ? opts.totalOf(memberRows) : groupTotal(memberRows),
      locked: opts.lockedOf ? opts.lockedOf(memberRows) : isGroupLocked(memberRows),
      ruleName: opts.ruleNameOf ? (opts.ruleNameOf(first.row) ?? null) : null,
    })
  }
  return models
}

/**
 * The distribution affordance one grid row shows: the applied-rule chip for
 * a group child, the staged-rule chip for a line carrying a distributionKey
 * the server has not exploded yet, the suggest-policy chip, or the plain
 * Split… entry point for any other priced line.
 */
export type RowDistributionChip =
  | { kind: 'rule'; ruleName: string; locked: boolean }
  | { kind: 'pending'; ruleName: string }
  | { kind: 'suggest'; ruleName: string }
  | { kind: 'split' }

export function chipForRow<Row extends DistributionGroupRow>(
  row: Row,
  index: number,
  opts: {
    ruleNameOf: (row: Row, index: number) => string | null
    pendingRuleNameOf: (row: Row, index: number) => string | null
    suggestionOf: (row: Row, index: number) => { ruleName: string } | null
    splittable: (row: Row, index: number) => boolean
  },
): RowDistributionChip | null {
  if (groupIdOf(row) !== null) {
    return { kind: 'rule', ruleName: opts.ruleNameOf(row, index) ?? '', locked: row.distributionLocked === true }
  }
  const pending = opts.pendingRuleNameOf(row, index)
  if (pending !== null && pending !== '') return { kind: 'pending', ruleName: pending }
  const suggestion = opts.suggestionOf(row, index)
  if (suggestion !== null) return { kind: 'suggest', ruleName: suggestion.ruleName }
  return opts.splittable(row, index) ? { kind: 'split' } : null
}

/** Row-action menu keys behind the Split… ContextMenu (labels resolve via entry.* in the grid). */
export type DistributionMenuKey = 'split' | 'unsplit' | 'lock' | 'unlock' | 'apply-suggest'

export function menuKeysForRow<Row extends DistributionGroupRow>(
  row: Row,
  index: number,
  opts: {
    pendingRuleNameOf: (row: Row, index: number) => string | null
    suggestionOf: (row: Row, index: number) => { ruleName: string } | null
    splittable: (row: Row, index: number) => boolean
  },
): DistributionMenuKey[] {
  const groupId = groupIdOf(row)
  if (groupId !== null) {
    return row.distributionLocked === true ? ['unlock', 'unsplit'] : ['lock', 'unsplit']
  }
  const keys: DistributionMenuKey[] = []
  if (opts.suggestionOf(row, index) !== null) keys.push('apply-suggest')
  if (opts.splittable(row, index) && !opts.pendingRuleNameOf(row, index)) keys.push('split')
  return keys
}

/**
 * Convert one hand-edited split (SplitLinesEditor portions) into exact child
 * amounts for a known line total. Fixed portions ride verbatim; percents are
 * exact via mulPercent (the editor's number is re-serialized as its shortest
 * decimal, never IEEE-754 arithmetic); remainder lines share the leftover
 * equally with the odd units on the earliest lines. Returns null when the
 * portions cannot make the total: a malformed/negative fixed or percent, an
 * over-allocated book (fixed + percent past the total), or no remainder line
 * to absorb the difference. Either way Σ(result) == total exactly.
 */
export type SplitPortion =
  | { kind: 'remainder' }
  | { kind: 'percent'; value: number }
  | { kind: 'fixed'; value: string }
  | { kind: 'weight'; value: string }

export function splitPortionsToAmounts(
  portions: readonly SplitPortion[],
  total: string,
): string[] | null {
  let totalUnits: bigint
  try {
    totalUnits = toUnits(total)
  } catch {
    return null
  }
  // Manual weights belong to allocation targets, not entry splits: a weight
  // names no amount, so a weight line can never price into the total. Fail
  // closed (the allocation drawer never offers this kind here).
  if (portions.some((portion) => portion.kind === 'weight')) return null
  const amounts = new Array<bigint>(portions.length).fill(0n)
  let placed = 0n
  for (let i = 0; i < portions.length; i++) {
    const portion = portions[i]!
    if (portion.kind === 'fixed') {
      let units: bigint
      try {
        units = toUnits(portion.value)
      } catch {
        return null
      }
      amounts[i] = units
      placed += units
    } else if (portion.kind === 'percent') {
      if (!Number.isFinite(portion.value) || portion.value < 0) return null
      let units: bigint
      try {
        units = toUnits(mulPercent(total, String(portion.value)))
      } catch {
        return null
      }
      amounts[i] = units
      placed += units
    }
  }
  const leftover = totalUnits - placed
  const remainderIndexes: number[] = []
  portions.forEach((portion, i) => {
    if (portion.kind === 'remainder') remainderIndexes.push(i)
  })
  if (remainderIndexes.length === 0) {
    if (leftover !== 0n) return null
    return amounts.map((units) => fromUnits(units))
  }
  if (leftover < 0n) return null
  const count = BigInt(remainderIndexes.length)
  const base = leftover / count
  const extra = leftover % count
  remainderIndexes.forEach((rowIndex, slot) => {
    amounts[rowIndex] = base + (BigInt(slot) < extra ? 1n : 0n)
  })
  return amounts.map((units) => fromUnits(units))
}

/** True when two ledger amounts differ — drives the dirty/re-explode checks. */
export function moneyDiffers(a: string, b: string): boolean {
  try {
    return cmp(a, b) !== 0
  } catch {
    return String(a) !== String(b)
  }
}
