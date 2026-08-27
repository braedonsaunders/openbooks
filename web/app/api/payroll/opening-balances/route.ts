import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import {
  assertTaxYear,
  OPENING_BALANCE_FIELDS,
  OpeningBalanceSaveError,
  openingBalancesForYear,
  saveOpeningBalances,
  type OpeningBalanceWrite,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { type Authz } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { guardPayrollEmployees } from '../subsidiary-scope'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mid-year adoption carry-in: the statutory year-to-date an employer
 * accumulated on a previous payroll system, per employee per tax year.
 *
 * Reading is `payroll.read` and writing is `payroll.manage` — these amounts
 * are compensation facts that move CPP/EI/FICA withholding on a real cheque,
 * so they sit behind payroll's own permissions rather than the generic
 * `admin.setup.manage` the Setup registry API uses.
 *
 * Every rule (money validation, the cross-field sanity checks, and the refusal
 * to edit a carry-in a committed run already consumed) lives in
 * engine/src/payroll-opening-balances.ts, which is the single write path. This
 * route only translates HTTP.
 */

async function currentTaxYear(orgId: string): Promise<number> {
  return Number((await businessToday(orgId)).slice(0, 4))
}

async function parseYear(orgId: string, raw: string | null): Promise<number> {
  if (!raw) return currentTaxYear(orgId)
  const year = Number(raw)
  return Number.isInteger(year) ? year : currentTaxYear(orgId)
}

async function visibleEmployeeIds(orgId: string, gate: Authz): Promise<Set<string> | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const rows = await db.execute<{ id: string }>(sql`
    select id from parties p
     where p.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}`)
  return new Set(rows.rows.map((row) => row.id))
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  let year: number
  try {
    year = assertTaxYear(await parseYear(gate.user.orgId, new URL(req.url).searchParams.get('year')))
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 422 })
  }
  const data = await openingBalancesForYear(gate.user.orgId, year)
  const visible = await visibleEmployeeIds(gate.user.orgId, gate)
  if (visible) {
    const rows = data.rows.filter((row) => visible.has(row.employeePartyId))
    const years = (await db.execute<{ taxYear: number }>(sql`
      select distinct b.tax_year as "taxYear"
        from payroll_opening_balances b
        join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
       where b.org_id = ${gate.user.orgId}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}
       order by b.tax_year desc`)).rows.map((row) => Number(row.taxYear))
    return NextResponse.json({
      ...data,
      rows,
      entered: rows.filter((row) => row.amounts !== null).length,
      years,
      fields: OPENING_BALANCE_FIELDS.map((field) => ({
        key: field.key, label: field.label, help: field.help, packs: field.packs,
      })),
    })
  }
  return NextResponse.json({
    ...data,
    fields: OPENING_BALANCE_FIELDS.map((field) => ({
      key: field.key, label: field.label, help: field.help, packs: field.packs,
    })),
  })
}

interface SaveBody {
  taxYear?: unknown
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

/** Component openings arrive keyed by component id (or code); values are text. */
function componentAmounts(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
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

  const rows: OpeningBalanceWrite[] = []
  for (const raw of body.rows) {
    const row = raw as { employeePartyId?: unknown; amounts?: unknown; components?: unknown }
    if (typeof row?.employeePartyId !== 'string' || !isUuid(row.employeePartyId)) {
      return NextResponse.json({ error: 'each row needs a valid employeePartyId' }, { status: 422 })
    }
    if (row.amounts != null && (typeof row.amounts !== 'object' || Array.isArray(row.amounts))) {
      return NextResponse.json({ error: 'amounts must be an object' }, { status: 422 })
    }
    const amounts = persistMoneyMap((row.amounts ?? {}) as Record<string, unknown>)
    if (amounts === 'invalid') {
      return NextResponse.json({ error: 'opening-balance amounts must be exact decimals' }, { status: 422 })
    }
    const rawComponents = componentAmounts(row.components)
    let components: Record<string, unknown> | undefined
    if (rawComponents !== undefined) {
      const persisted = persistMoneyMap(rawComponents)
      if (persisted === 'invalid') {
        return NextResponse.json({ error: 'opening-balance component amounts must be exact decimals' }, { status: 422 })
      }
      components = persisted
    }
    rows.push({
      employeePartyId: row.employeePartyId,
      amounts,
      // Absent means "this client does not speak components", which the service
      // treats as "keep what is stored". Sending {} is how the grid clears them.
      components,
    })
  }

  const denied = await guardPayrollEmployees(
    gate,
    rows.map((row) => row.employeePartyId),
  )
  if (denied) return denied

  try {
    const result = await saveOpeningBalances({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      taxYear: assertTaxYear(body.taxYear),
      rows,
    })
    return NextResponse.json(result)
  } catch (error) {
    // A refusal is data the operator has to see per row, not a bare 4xx: a
    // whole-workforce load rejected for one transposed column must say which
    // employee, and nothing was written.
    if (error instanceof OpeningBalanceSaveError) {
      return NextResponse.json(
        { error: error.message, errors: error.result.errors, created: 0, updated: 0, deleted: 0 },
        { status: 409 },
      )
    }
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid request'
}
