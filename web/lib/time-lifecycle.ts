/**
 * Timesheet lifecycle: what a week may still become, and why it may not.
 *
 * Approval is only meaningful if the approved record cannot quietly change
 * afterwards, so approved time is read-only. But "read-only forever" is not a
 * lifecycle — a genuine mistake found the day after approval has to have a
 * route back. Reopening is that route, and it is safe exactly while nothing
 * downstream has consumed the entry:
 *
 *   invoiced   → the customer has been billed for these hours
 *   paid       → the hours went through a pay run
 *   costed     → the labour cost was posted to the ledger
 *   ticketed   → the hours are inside a signed field ticket
 *
 * Once any of those is true the entry is evidence for a document that already
 * exists, and the correction is an amendment (a new, offsetting entry that
 * references the original), never an edit of history.
 *
 * This module is pure so the same answer drives the API guard, the button
 * state, and the explanation text — a lock the UI merely hides is not a lock.
 */

/** Downstream consumers that pin a time entry. Order is the reporting order. */
export const LOCK_REASONS = ['invoiced', 'paid', 'costed', 'ticketed'] as const
export type LockReason = (typeof LOCK_REASONS)[number]

/** The provenance columns that decide whether an entry is still free. */
export interface EntryProvenance {
  invoicedByLineId: string | null
  payrollBatchRef: string | null
  costJournalEntryId: string | null
  fieldTicketId: string | null
}

/** Every downstream consumer holding this entry, in reporting order. */
export function lockReasonsFor(entry: EntryProvenance): LockReason[] {
  const reasons: LockReason[] = []
  if (entry.invoicedByLineId) reasons.push('invoiced')
  if (entry.payrollBatchRef) reasons.push('paid')
  if (entry.costJournalEntryId) reasons.push('costed')
  if (entry.fieldTicketId) reasons.push('ticketed')
  return reasons
}

/** Union of the lock reasons across a whole week, deduped and ordered. */
export function weekLockReasons(entries: EntryProvenance[]): LockReason[] {
  const found = new Set<LockReason>()
  for (const entry of entries) for (const reason of lockReasonsFor(entry)) found.add(reason)
  return LOCK_REASONS.filter((reason) => found.has(reason))
}

export interface ReopenDecision {
  /** True when every entry in the week is free of downstream consumers. */
  allowed: boolean
  /** Why not, for the message. Empty when allowed. */
  reasons: LockReason[]
  /** How many entries are pinned (0 when allowed). */
  lockedCount: number
}

/**
 * Whether an approved week may be returned to draft.
 *
 * Deliberately all-or-nothing: reopening part of a week would leave the week
 * aggregate reading "draft" while some of its hours are already invoiced or
 * paid, which is exactly the ambiguity approval exists to prevent.
 */
export function canReopenWeek(entries: EntryProvenance[]): ReopenDecision {
  const lockedCount = entries.filter((entry) => lockReasonsFor(entry).length > 0).length
  const reasons = weekLockReasons(entries)
  return { allowed: lockedCount === 0, reasons, lockedCount }
}

/**
 * Whether a week's status permits reopening at all. Only an approved week is
 * reopenable; draft/rejected are already editable and submitted is withdrawn
 * rather than reopened.
 */
export function isReopenableStatus(status: string): boolean {
  return status === 'approved'
}
