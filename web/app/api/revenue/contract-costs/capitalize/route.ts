import { NextResponse } from 'next/server'
import { z } from 'zod'
import { capitalizeContractCost } from '@openbooks/engine/revenue'
import { defineRoute } from '@/lib/api/route'
import { isoDate, parseJsonBody, uuidId } from '@/lib/api/json'
import { contractCostErrorResponse, parseCostAmountMinor } from '@/lib/contract-costs'

export const runtime = 'nodejs'

const scopedId = (label: string) =>
  z
    .string({ error: `invalid ${label}` })
    .refine((v) => uuidId.safeParse(v).success, `invalid ${label}`)
    .optional()

const capitalizeBody = z.object({
  revenueContractId: scopedId('contract'),
  repPartyId: scopedId('rep'),
  customerPartyId: scopedId('customer'),
  costType: z.enum(['commission', 'fulfilment']).optional(),
  amount: z.string().min(1),
  currency: z.string().min(3).max(3),
  capitalizedOn: isoDate(),
  method: z.enum(['straight_line', 'pattern']).optional(),
  originalExpenseAccountId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid account'),
  renewalCommission: z.string().optional(),
  sourceKind: z.enum(['manual', 'import', 'payroll_earning', 'vendor_bill']).optional(),
  sourceRef: z.string().max(200).optional(),
})

/**
 * Capitalize a contract cost: DR contract-cost asset, CR the cost's original
 * expense or accrual account. Costs the policy excludes, or whose benefit
 * period the one-year practical expedient covers, expense immediately with
 * no journal — the response says which happened.
 */
export const POST = defineRoute({
  permission: 'contract_costs.manage',
  feature: 'contractCosts',
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user
    const parsed = await parseJsonBody(req, capitalizeBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    try {
      const amountMinor = await parseCostAmountMinor(user.orgId, body.amount, body.currency)
      const renewalCommissionMinor = body.renewalCommission
        ? await parseCostAmountMinor(user.orgId, body.renewalCommission, body.currency)
        : undefined
      const result = await capitalizeContractCost({
        orgId: user.orgId,
        actorId: user.id,
        revenueContractId: body.revenueContractId,
        repPartyId: body.repPartyId,
        customerPartyId: body.customerPartyId,
        costType: body.costType ?? 'commission',
        amountMinor,
        currency: body.currency,
        capitalizedOn: body.capitalizedOn,
        method: body.method,
        originalExpenseAccountId: body.originalExpenseAccountId,
        renewalCommissionMinor,
        source: { kind: body.sourceKind ?? 'manual', ref: body.sourceRef ?? null },
      })
      return NextResponse.json(result, { status: 201 })
    } catch (e: unknown) {
      return contractCostErrorResponse(e, 'Unable to capitalize the contract cost.')
    }
  },
})
