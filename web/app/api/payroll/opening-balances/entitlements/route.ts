import { jsonObject, parseJsonBody } from "@/lib/api/json";
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
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { scopedEntitlementOpenings } from '../../../../../lib/payroll-scoped-views'
import { guardPayrollEmployees } from '../../subsidiary-scope'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const asOf = new URL(req.url).searchParams.get('asOf')
  try {
    const data = await scopedEntitlementOpenings(gate, { asOf: asOf ? assertMovementDate(asOf) : undefined })
    return NextResponse.json(data)
  } catch (error) {
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

interface SaveBody {
  movementDate?: unknown
  note?: unknown
  rows?: unknown
}

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

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: SaveBody
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as SaveBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows must be an array' }, { status: 422 })
  }

  const rows: EntitlementOpeningWrite[] = []
  for (const raw of body.rows) {
    const row = raw as { employeePartyId?: unknown; amounts?: unknown }
    if (typeof row?.employeePartyId !== 'string' || !isUuid(row.employeePartyId)) {
      return NextResponse.json({ error: 'each row needs a valid employeePartyId' }, { status: 422 })
    }
    if (row.amounts != null && (typeof row.amounts !== 'object' || Array.isArray(row.amounts))) {
      return NextResponse.json({ error: 'amounts must be an object' }, { status: 422 })
    }
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
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    })
    return NextResponse.json(result)
  } catch (error) {
    // A refusal is per-row data the operator has to act on, not a bare 4xx, and
    // nothing was written.
    if (error instanceof EntitlementOpeningSaveError) {
      return NextResponse.json(
        {
          error: error.message,
          errors: error.result.errors,
          warnings: error.result.warnings,
          created: 0, updated: 0, deleted: 0,
        },
        { status: 409 },
      )
    }
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}
