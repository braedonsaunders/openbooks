import { uuidId } from "@/lib/api/json-schema"
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import {
  assertMovementDate,
  EntitlementOpeningSaveError,
  saveEntitlementOpenings,
  type EntitlementOpeningWrite,
} from '@openbooks/engine/src/payroll/entitlements.ts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../lib/payroll-decimal-refusal'
import '../../../../../lib/feature-gates';
import { scopedEntitlementOpenings } from '../../../../../lib/payroll-scoped-views'
import { guardPayrollEmployees } from '../../subsidiary-scope'
import '../../../../../lib/list-params';

const entitlementAmount = z.string().superRefine((value, ctx) => {
  if (value.trim() === '') return
  if (canonicalDecimal(value, 4) === null) {
    ctx.addIssue({ code: 'custom', message: moneyRefusal('Entitlement amount', value) })
  }
})
const requestBodySchema = z.strictObject({
  movementDate: z.string().refine((value) => {
    try { assertMovementDate(value); return true } catch { return false }
  }, 'movementDate must be a real calendar date (YYYY-MM-DD)'),
  note: z.string().trim().max(2000).nullable().optional(),
  rows: z.array(z.strictObject({
    employeePartyId: uuidId,
    amounts: z.record(z.string(), entitlementAmount).optional(),
  })),
})


export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'payroll.read',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const asOf = new URL(req.url).searchParams.get('asOf')
    try {
      const data = await scopedEntitlementOpenings(gate, { asOf: asOf ? assertMovementDate(asOf) : undefined })
      return NextResponse.json(data)
    } catch (error) {
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 })
      }
      throw error
    }

  },
})

/** Exact numeric(19,4) money string, empty when omitted, or 'invalid'. */
function persistMoney(value: unknown): string | '' | 'invalid' {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return ''
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

// The refusal names the offending entry, so the map carries the first bad
// key and value instead of a bare 'invalid' no message can observe.
type MoneyMap = { ok: true; map: Record<string, unknown> } | { ok: false; key: string; value: unknown }
function persistMoneyMap(raw: Record<string, unknown>): MoneyMap {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const persisted = persistMoney(value)
    if (persisted === 'invalid') return { ok: false, key, value }
    out[key] = persisted
  }
  return { ok: true, map: out }
}

export const POST = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {

    const parsedBody = await parseJsonBody(req, requestBodySchema)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data

    const rows: EntitlementOpeningWrite[] = []
    for (const row of body.rows) {
      const amounts = persistMoneyMap((row.amounts ?? {}) as Record<string, unknown>)
      if (!amounts.ok) {
        return NextResponse.json({ error: moneyRefusal(`Entitlement amount for "${amounts.key}"`, amounts.value) }, { status: 422 })
      }
      rows.push({
        employeePartyId: row.employeePartyId,
        amounts: amounts.map,
      })
    }

    const denied = await guardPayrollEmployees(
      gate,
      rows.map((row) => row.employeePartyId),
    )
    if (denied) return denied

    try {
      const result = await saveEntitlementOpenings({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        movementDate: assertMovementDate(body.movementDate),
        rows,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        note: body.note?.trim() || null,
      })
      return NextResponse.json(result)
    } catch (error) {
      // A refusal is per-row data the operator has to act on, not a bare 4xx, and
      // nothing was written.
      if (error instanceof EntitlementOpeningSaveError) {
        return apiErrorResponse(error, {
          safeStatus: 409,
          details: {
            errors: error.result.errors,
            warnings: error.result.warnings,
            created: 0,
            updated: 0,
            deleted: 0,
          },
        })
      }
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 })
      }
      throw error
    }

  },
})
