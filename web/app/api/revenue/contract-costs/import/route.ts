import { NextResponse } from 'next/server'
import { z } from 'zod'
import { importCommissionCosts } from '@openbooks/engine/revenue'
import { defineRoute } from '../../../../lib/api/route'
import { isoDate, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { contractCostErrorResponse, parseCostAmountMinor } from '../../../../lib/contract-costs'

export const runtime = 'nodejs'

const scopedId = (label: string) =>
  z
    .string({ error: `invalid ${label}` })
    .refine((v) => uuidId.safeParse(v).success, `invalid ${label}`)
    .optional()

const importRow = z.object({
  repPartyId: scopedId('rep'),
  customerPartyId: scopedId('customer'),
  contractNumber: z.string().max(60).optional(),
  costType: z.enum(['commission', 'fulfilment']).optional(),
  amount: z.string().min(1),
  currency: z.string().min(3).max(3),
  date: isoDate(),
  method: z.enum(['straight_line', 'pattern']).optional(),
  originalExpenseAccountId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid account'),
  renewalCommission: z.string().optional(),
  ref: z.string().max(200).optional(),
})

const importBody = z.object({ rows: z.array(importRow).min(1).max(500) })

/**
 * Import CaptivateIQ/QuotaPath-style commission rows. Every row answers
 * for itself: resolved contracts capitalize, unknown ones queue unlinked,
 * and a bad row refuses with its remedy without blocking its siblings.
 */
export const POST = defineRoute({
  permission: 'contract_costs.manage',
  feature: 'contractCosts',
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user
    const parsed = await parseJsonBody(req, importBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    try {
      const rows = []
      for (const row of parsed.data.rows) {
        rows.push({
          repPartyId: row.repPartyId,
          customerPartyId: row.customerPartyId,
          contractNumber: row.contractNumber,
          costType: row.costType,
          amountMinor: await parseCostAmountMinor(user.orgId, row.amount, row.currency),
          currency: row.currency,
          date: row.date,
          method: row.method,
          originalExpenseAccountId: row.originalExpenseAccountId,
          renewalCommissionMinor: row.renewalCommission
            ? await parseCostAmountMinor(user.orgId, row.renewalCommission, row.currency)
            : undefined,
          ref: row.ref,
        })
      }
      const result = await importCommissionCosts({ orgId: user.orgId, actorId: user.id, rows })
      return NextResponse.json({ rows: result }, { status: 201 })
    } catch (e: unknown) {
      return contractCostErrorResponse(e, 'Unable to import the commission rows.')
    }
  },
})
