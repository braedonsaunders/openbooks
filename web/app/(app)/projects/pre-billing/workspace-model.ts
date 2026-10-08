import { PREBILL_STAGES, type PrebillStage } from '../../../../lib/pre-billing-stages'
import { decimalSum } from '../../../../lib/statement-format'
import type { PrebillListRow, UnbilledProjectRow } from '../../../../lib/pre-billing'

type ActivePrebillStage = Exclude<PrebillStage, 'paid' | 'void'>
function isActivePrebillStage(stage: PrebillStage): stage is ActivePrebillStage {
  return stage !== 'paid' && stage !== 'void'
}

/** The operational workflow follows native stages; closed records retain their lifecycle outside this dashboard. */
export const WORKSPACE_STAGES = ['unbilled', ...PREBILL_STAGES.filter(isActivePrebillStage)] as const
export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number]
export type WorkspaceEntry =
  | { kind: 'unbilled'; key: string; stage: 'unbilled'; amount: string; source: UnbilledProjectRow }
  | { kind: 'prebill'; key: string; stage: ActivePrebillStage; amount: string; source: PrebillListRow }

export function parseWorkspaceStage(value: string | null): WorkspaceStage {
  return WORKSPACE_STAGES.find((stage) => stage === value) ?? 'unbilled'
}

/** Both views display the issued invoice amount once a worksheet has an invoice. */
export function prebillDisplayAmount(row: PrebillListRow): string {
  return row.invoiceTotal ?? row.proposedBillAmount
}

/**
 * Project work and worksheets keep separate identities and commands. Board
 * columns and table tabs share one ordered workflow and search counts. Stage
 * selection highlights a board column and filters the corresponding table.
 */
export function projectWorkspace(input: {
  prebills: readonly PrebillListRow[]
  unbilled: readonly UnbilledProjectRow[]
  query: string
  stage: string | null
  approvalFlowsConfigured: boolean
  customerPortalEnabled: boolean
}) {
  const activePrebills = input.prebills.filter((row): row is PrebillListRow & { stage: ActivePrebillStage } => isActivePrebillStage(row.stage))
  const entries: WorkspaceEntry[] = [
    ...input.unbilled.map((source): WorkspaceEntry => ({
      kind: 'unbilled', key: `project:${source.projectId}`, stage: 'unbilled', amount: source.unbilledAmount, source,
    })),
    ...activePrebills.map((source): WorkspaceEntry => ({
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
    if (stage === 'review') return input.approvalFlowsConfigured || activePrebills.some((row) => row.stage === 'review')
    if (stage === 'customer') return input.customerPortalEnabled || activePrebills.some((row) => row.stage === 'customer' || row.customerReviewRequired)
    return true
  }).map((key) => {
    const rows = matching.filter((entry) => entry.stage === key)
    return { key, rows, count: rows.length, total: decimalSum(rows.map((entry) => entry.amount)) }
  })
  const selectedStage = stages.find(({ key }) => key === parseWorkspaceStage(input.stage)) ?? stages[0]!
  return {
    stages, lanes: stages, rows: selectedStage.rows, activeStage: selectedStage.key,
    total: selectedStage.total,
    nothingYet: entries.length === 0,
  }
}
