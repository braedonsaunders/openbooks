import type { InvoiceRollup, InvoiceRollupGroup, InvoicingProfile } from '@openbooks/schema/src/project-types.ts'
import { add, normalizeDecimal } from '@openbooks/engine/src/money.ts'

/**
 * Invoice rollup — presenting billed work the way a customer has agreed to see it.
 *
 * What is billed and how it is presented are different questions. The engine
 * decides the first from tickets, orders and rates; this decides only the second.
 * Detail is never lost — it stays on the document's lines and its backup — so a
 * rollup can be changed after the fact without rebuilding anything.
 *
 * The rule is resolved project > customer > project type, because the agreement
 * lives with the customer and is sometimes specific to one job. Without those
 * layers tenants clone a project type per customer just to change the wording.
 */

/** Whatever a line needs to expose for a group to match it. */
export interface RollupLine {
  amount: string
  quantity: string
  description: string | null
  itemId?: string | null
  itemKind?: string | null
  itemCategory?: string | null
  sourceKind?: string | null
  isLabor?: boolean
}

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()
/** Invoice quantities use eight decimal places, independently of money. */
export function addInvoiceQuantities(left: string, right: string): string {
  const units = (value: string) => BigInt(normalizeDecimal(value, 8).replace('.', ''))
  return normalizeDecimal(`${units(left) + units(right)}e-8`, 8).replace(/0{1,4}$/, '')
}
const listHas = (list: string[] | undefined, value: unknown) =>
  !list?.length || list.some((entry) => lower(entry) === lower(value))

/**
 * A group's conditions are ANDed: every one it states must hold. Conditions it
 * does not state are not constraints, so `{label, isLabor: true}` is simply "the
 * labor", and stating nothing would match everything — which is why an empty
 * group is rejected when the profile is validated rather than silently eating
 * the invoice.
 */
export function lineMatchesGroup(line: RollupLine, group: InvoiceRollupGroup): boolean {
  if (group.isLabor !== undefined && group.isLabor !== (line.isLabor === true)) return false
  if (group.itemCategories?.length && !listHas(group.itemCategories, line.itemCategory)) return false
  if (group.itemKinds?.length && !listHas(group.itemKinds, line.itemKind)) return false
  if (group.sourceKinds?.length && !listHas(group.sourceKinds, line.sourceKind)) return false
  return true
}

export interface RollupResult<L extends RollupLine> {
  /** What the customer is shown, in the order the groups were declared. */
  presented: L[]
  /**
   * For each input line, the index in `presented` that now carries it. Rolling
   * up must never cost the audit trail: every source row still has to be marked
   * billed by a real invoice line, or it becomes available to bill a second time.
   */
  presentedIndexOf: number[]
  /** True when presentation differs from the underlying lines. */
  collapsed: boolean
}

/**
 * Collapse lines into the declared groups. A line that matches no group KEEPS
 * ITS OWN LINE: a presentation rule that quietly dropped a charge would be a
 * revenue leak, so anything unrecognised stays visible and is obvious to fix.
 * Callers may partition each group by the distinctions they must preserve.
 * Partitions retain first-seen order within each group; the builder receives
 * their original members so it can carry the corresponding metadata forward.
 */
export function applyRollup<L extends RollupLine>(
  lines: L[],
  rollup: InvoiceRollup | undefined,
  makeLine: (group: InvoiceRollupGroup, amount: string, quantity: string, members: L[]) => L,
  partitionBy?: (line: L) => string,
): RollupResult<L> {
  const identity = () => lines.map((_, index) => index)
  if (!rollup || rollup.mode !== 'by_group' || !rollup.groups?.length) {
    return { presented: lines, presentedIndexOf: identity(), collapsed: false }
  }

  type Partition = { amount: string; quantity: string; members: L[]; sourceIndexes: number[] }
  const totals = new Map<number, Map<string, Partition>>()
  const groupOf = lines.map((line) => rollup.groups!.findIndex((g) => lineMatchesGroup(line, g)))
  for (const [i, line] of lines.entries()) {
    const index = groupOf[i]!
    if (index < 0) continue
    const partitions = totals.get(index) ?? new Map<string, Partition>()
    const key = partitionBy?.(line) ?? ''
    const prior = partitions.get(key) ?? { amount: '0', quantity: '0', members: [], sourceIndexes: [] }
    prior.amount = add(prior.amount, line.amount)
    // document_lines.quantity has eight decimal places; money addition cannot
    // represent its fractional units. Normalize first to reject precision loss.
    prior.quantity = addInvoiceQuantities(prior.quantity, line.quantity)
    prior.members.push(line)
    prior.sourceIndexes.push(i)
    partitions.set(key, prior)
    totals.set(index, partitions)
  }
  if (!totals.size) return { presented: lines, presentedIndexOf: identity(), collapsed: false }

  const presented: L[] = []
  const presentedIndexOf: number[] = new Array(lines.length)
  rollup.groups.forEach((group, index) => {
    const partitions = totals.get(index)
    if (!partitions) return
    for (const total of partitions.values()) {
      for (const sourceIndex of total.sourceIndexes) presentedIndexOf[sourceIndex] = presented.length
      presented.push(makeLine(group, total.amount, total.quantity, total.members))
    }
  })
  // Anything unrecognised keeps its own line, in its original order.
  lines.forEach((line, i) => {
    if (groupOf[i]! >= 0) return
    presentedIndexOf[i] = presented.length
    presented.push(line)
  })
  return { presented, presentedIndexOf, collapsed: true }
}

/**
 * Resolve the invoicing rules in force: the project type's, narrowed by the
 * customer's agreement, then by anything specific to this job. Each layer
 * overrides whole keys — a customer that states a rollup replaces the type's
 * rollup rather than merging groups into it, because half-merged presentation
 * rules are impossible to reason about.
 */
export function resolveInvoicingProfile(
  fromProjectType: InvoicingProfile,
  fromCustomer?: Partial<InvoicingProfile> | null,
  fromProject?: Partial<InvoicingProfile> | null,
): InvoicingProfile {
  const defined = (o?: Partial<InvoicingProfile> | null) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null))
  return { ...fromProjectType, ...defined(fromCustomer), ...defined(fromProject) }
}

/** Reasons a rollup would be unsafe to apply, for the editor to surface. */
export function rollupProblems(rollup: InvoiceRollup | undefined): string[] {
  if (!rollup || rollup.mode !== 'by_group') return []
  const problems: string[] = []
  if (!rollup.groups?.length) problems.push('Grouped presentation needs at least one group')
  rollup.groups?.forEach((group, index) => {
    const position = group.label?.trim() ? `"${group.label}"` : `Group ${index + 1}`
    if (!group.label?.trim()) problems.push(`${position} needs a label`)
    const states =
      group.isLabor !== undefined ||
      !!group.itemCategories?.length ||
      !!group.itemKinds?.length ||
      !!group.sourceKinds?.length
    if (!states) problems.push(`${position} matches every line — give it a condition`)
  })
  return problems
}
