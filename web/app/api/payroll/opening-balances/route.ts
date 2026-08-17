import { NextResponse } from 'next/server'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import {
  assertTaxYear,
  OPENING_BALANCE_FIELDS,
  OpeningBalanceSaveError,
  openingBalancesForYear,
  saveOpeningBalances,
  type OpeningBalanceWrite,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
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

function currentTaxYear(): number {
  return new Date().getUTCFullYear()
}

function parseYear(raw: string | null): number {
  if (!raw) return currentTaxYear()
  const year = Number(raw)
  return Number.isInteger(year) ? year : currentTaxYear()
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  let year: number
  try {
    year = assertTaxYear(parseYear(new URL(req.url).searchParams.get('year')))
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 422 })
  }
  const data = await openingBalancesForYear(gate.user.orgId, year)
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
    body = (await req.json()) as SaveBody
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
    rows.push({
      employeePartyId: row.employeePartyId,
      amounts: (row.amounts ?? {}) as Record<string, unknown>,
      // Absent means "this client does not speak components", which the service
      // treats as "keep what is stored". Sending {} is how the grid clears them.
      components: componentAmounts(row.components),
    })
  }

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
