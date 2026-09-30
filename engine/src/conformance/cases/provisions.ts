/** Governed provision recognition and periodic review through the native
 * Accounting changes approval path and the real posting kernel. */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,  withOrgContext } from '../../platform/db.ts'
import { seedFlowActors, seedApprovalFlow } from '../../testing/fixtures.ts'
import { submitFinancialChange } from '../../flows/financial-changes-adapter.ts'
import { decideGate } from '../../flows/gates.ts'
import { proposeProvisionAssessment, applyProvisionAssessment, type ProvisionProposal } from '../../provisions/assessments.ts'
import { capture } from '../ledger-helpers.ts'
import type { CaseContext, ConformanceCase } from '../types.ts'

async function approvedAssessment(ctx: CaseContext) {
  const ledger = ctx.ledger!
  const actors = await withOrgContext(ledger.orgId, async () => {
    const actors = await seedFlowActors(ledger.orgId)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{reportingFramework}','"ifrs"') where id=${ledger.orgId}`)
    await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
      (${ledger.orgId},${actors.submitterId},'gl.manage','grant'),(${ledger.orgId},${actors.submitterId},'gl.post','grant')`)
    await seedApprovalFlow(ledger.orgId, { subjectKind: 'financial_change', assignees: [{ type: 'user', userId: actors.approver1Id }], mode: 'any', preventSelfApproval: true })
    return actors
  })
  const obligation = { id: randomUUID(), subsidiaryId: ledger.subsidiaryId, bookId: ledger.bookId,
    name: 'Defective-work settlement obligation', currency: 'CAD', expenseAccountId: ctx.roles.provisionExpense, liabilityAccountId: ctx.roles.provisionLiability }
  return async (amount: string) => withOrgContext(ledger.orgId, async () => {
    const input: ProvisionProposal = { obligation, effectiveOn: ledger.date,
      reason: 'Record the current counsel-supported settlement assessment', idempotencyKey: randomUUID(),
      assessment: { presentObligation: true, outflow: 'probable', reliablyEstimable: true,
        evidence: 'Counsel confirms a present legal obligation from defective work and a probable settlement.',
        discounting: 'immaterial', discountEvidence: 'Settlement is expected shortly; the effect of time value is immaterial.',
        estimate: { method: 'best_estimate', amount } } }
    const id = await proposeProvisionAssessment(ledger.orgId, actors.submitterId, input)
    await submitFinancialChange(ledger.orgId, id, actors.submitterId)
    const gate = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${id} and status='pending'`)).rows[0]!
    await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: 'approved' })
    return applyProvisionAssessment(ledger.orgId, id, actors.submitterId)
  })
}

export const PROVISION_CASES: readonly ConformanceCase[] = [
  {
    id: "prov-recognition-threshold",
    title: "A probable, estimable obligation is recognised as a provision",
    citations: [
      {
        standard: "IAS 37",
        reference: "IAS 37.14",
        kind: "requirement",
        requirement:
          "A provision is recognised when a present obligation from a past event makes an outflow of resources probable and the amount can be estimated reliably.",
      },
      {
        standard: "ASC 450",
        reference: "450-20-25-2",
        kind: "requirement",
        requirement:
          "An estimated loss from a loss contingency is accrued when it is probable that a liability has been incurred and the amount of loss can be reasonably estimated.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A lawsuit that will probably cost 50,000.00 appears on the balance sheet now — a probable obligation is never left off the books until the cash leaves.",
    facts: [
      "A past event (a filed claim for defective work) creates a present legal obligation.",
      "Settlement is judged probable and counsel estimates 50,000.00 reliably.",
      "A provision of 50,000.00 is recognised: the charge hits profit or loss and the liability sits on the balance sheet.",
    ],
    expected: {
      entries: [{ step: "recognition", lines: [{ role: "provisionExpense", amount: "50000.0000" }, { role: "provisionLiability", amount: "-50000.0000" }] }],
      values: {
        provisionLiability: "50000.0000",
        profitOrLossCharge: "50000.0000",
      },
    },
    run: async ctx => {
      const assess = await approvedAssessment(ctx)
      let result: Record<string, unknown> = {}
      const entry = await capture(ctx, 'recognition', async () => { result = await assess('50000') })
      return { entries: [entry], values: { provisionLiability: String(result.liability), profitOrLossCharge: String(result.currentPeriodCharge) } }
    },
  },

  {
    id: "prov-best-estimate-measurement",
    title: "A provision is measured at the best estimate and reviewed every period",
    citations: [
      {
        standard: "IAS 37",
        reference: "IAS 37.36",
        kind: "requirement",
        requirement:
          "The amount recognised as a provision is the best estimate of the expenditure required to settle the present obligation at the reporting date.",
      },
      {
        standard: "IAS 37",
        reference: "IAS 37.59",
        kind: "requirement",
        requirement:
          "Provisions are reviewed at the end of each reporting period and adjusted to reflect the current best estimate.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The provision tracks the current best estimate — when new information moves the estimate from 50,000.00 to 65,000.00, a further 15,000.00 is charged in the period the estimate changes.",
    facts: [
      "An opening provision of 50,000.00 for the filed claim.",
      "Before year end, counsel revises the best estimate of the settlement to 65,000.00.",
      "The provision is adjusted to 65,000.00 with a 15,000.00 charge in the current period.",
    ],
    expected: {
      entries: [{ step: "review", lines: [{ role: "provisionExpense", amount: "15000.0000" }, { role: "provisionLiability", amount: "-15000.0000" }] }],
      values: {
        revisedProvision: "65000.0000",
        currentPeriodCharge: "15000.0000",
      },
    },
    run: async ctx => {
      const assess = await approvedAssessment(ctx)
      await assess('50000')
      let result: Record<string, unknown> = {}
      const entry = await capture(ctx, 'review', async () => { result = await assess('65000') })
      return { entries: [entry], values: { revisedProvision: String(result.liability), currentPeriodCharge: String(result.currentPeriodCharge) } }
    },
  },
];
