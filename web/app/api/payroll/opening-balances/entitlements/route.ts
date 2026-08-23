import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import {
  assertMovementDate,
  EntitlementOpeningSaveError,
  entitlementOpenings,
  saveEntitlementOpenings,
  type EntitlementOpeningWrite,
} from '@openbooks/engine/src/payroll-entitlements.ts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mid-year adoption carry-in for entitlement PLANS — the vacation and
 * banked-time balances an employee arrives holding.
 *
 * A sibling of ../route.ts rather than part of it, because the fact has a
 * different key: a bank has one lifetime balance, not one per tax year (the
 * ledger's unique index is (org, plan, employee) with no year). Folding it into
 * the year-scoped payload would invite an operator to re-enter the same balance
 * once per year and double an employer's liability.
 *
 * Same permissions as the statutory carry-in — `payroll.read` / `payroll.manage`
 * — and every rule (money validation, the sign check against the plan's
 * direction, the refusal to restate a carry-in a committed run consumed) lives
 * in engine/src/payroll-entitlements.ts. This route only translates HTTP.
 */

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const asOf = new URL(req.url).searchParams.get('asOf')
  try {
    return NextResponse.json(
      await entitlementOpenings(gate.user.orgId, { asOf: asOf ? assertMovementDate(asOf) : undefined }),
    )
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

function persistMoneyMap(raw: Record<string, unknown>): Record<string, unknown> | 'invalid' {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const persisted = persistMoney(value)
    if (persisted === 'invalid') return 'invalid'
    out[key] = persisted
  }
  return out
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
    if (amounts === 'invalid') {
      return NextResponse.json({ error: 'entitlement opening amounts must be exact decimals' }, { status: 422 })
    }
    rows.push({
      employeePartyId: row.employeePartyId,
      amounts,
    })
  }

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
