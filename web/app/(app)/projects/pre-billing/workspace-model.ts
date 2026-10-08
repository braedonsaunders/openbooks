import { PREBILL_STAGES, type PrebillStage } from '../../../../lib/pre-billing-stages'
import { decimalSum } from '../../../../lib/statement-format'
import type { PrebillListRow, UnbilledProjectRow } from '../../../../lib/pre-billing'

export type WorkspaceStage = 'unbilled' | PrebillStage
export type WorkspaceEntry =
  | { kind: 'unbilled'; key: string; stage: 'unbilled'; amount: string; source: UnbilledProjectRow }
  | { kind: 'prebill'; key: string; stage: PrebillStage; amount: string; source: PrebillListRow }

export const CLOSED_CARD_LIMIT = 12
export const WORKSPACE_STAGES = ['unbilled', ...PREBILL_STAGES] as const

export function parseWorkspaceStage(value: string | null): WorkspaceStage | null {
  return WORKSPACE_STAGES.find((stage) => stage === value) ?? null
}

export function isClosedStage(stage: WorkspaceStage): boolean {
  return stage === 'paid' || stage === 'void'
}

/** Both views display the issued invoice amount once a worksheet has an invoice. */
export function prebillDisplayAmount(row: PrebillListRow): string {
  return row.invoiceTotal ?? row.proposedBillAmount
}

/**
 * Project work and worksheets keep separate identities and commands. Counts
 * describe search matches before stage selection; totals include every match,
 * independently of table pagination or the board's closed-card limit.
 */
export function projectWorkspace(input: {
  prebills: readonly PrebillListRow[]
  unbilled: readonly UnbilledProjectRow[]
  query: string
  stage: WorkspaceStage | null
  approvalFlowsConfigured: boolean
  customerPortalEnabled: boolean
}) {
  const entries: WorkspaceEntry[] = [
    ...input.unbilled.map((source): WorkspaceEntry => ({
      kind: 'unbilled', key: `project:${source.projectId}`, stage: 'unbilled', amount: source.unbilledAmount, source,
    })),
    ...input.prebills.map((source): WorkspaceEntry => ({
      kind: 'prebill', key: `prebill:${source.id}`, stage: source.stage, amount: prebillDisplayAmount(source), source,
    })),
  ]
  const needle = input.query.trim().toLowerCase()
  const matching = entries.filter((entry) => {
    const source = entry.source
    const terms = [source.projectName, source.customerName]
    if (entry.kind === 'prebill') terms.push(entry.source.worksheetNumber, entry.source.invoiceNumber)
    return !needle || terms.some((value) => value?.toLowerCase().includes(needle))
  })
  const stages = WORKSPACE_STAGES.filter((stage) => {
    if (stage === input.stage) return true
    if (stage === 'review') return input.approvalFlowsConfigured || input.prebills.some((row) => row.stage === 'review')
    if (stage === 'customer') return input.customerPortalEnabled || input.prebills.some((row) => row.stage === 'customer' || row.customerReviewRequired)
    return true
  }).map((key) => {
    const rows = matching.filter((entry) => entry.stage === key)
    return { key, rows, count: rows.length, total: decimalSum(rows.map((entry) => entry.amount)) }
  })
  const open = matching.filter((entry) => !isClosedStage(entry.stage))
  const rows = input.stage ? matching.filter((entry) => entry.stage === input.stage) : open
  const lanes = stages.filter(({ key }) => input.stage ? key === input.stage : !isClosedStage(key))
  return {
    stages, lanes, rows, openCount: open.length,
    total: decimalSum(rows.map((entry) => entry.amount)),
    nothingYet: entries.length === 0,
  }
}
